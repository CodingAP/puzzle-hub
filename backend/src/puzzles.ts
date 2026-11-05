/**
 * backend/src/puzzles.ts
 *
 * puzzle files on disk (solution, inputs, readme, puzzle text) plus the metadata that goes with them, for any source
 */

import {
    findAnswer,
    getAnswers,
    getRuns,
    getStars,
    getStarsByGroup,
    getStarsForGroup,
    getStoredTitle,
    getTitlesForGroup,
    insertAnswer,
    storeTitle,
} from './db.ts';
import { ensureDir, exists, readTextOrNull } from './fs.ts';
import { listGroupInfos, providerContext, puzzlePaths, type Source } from './sources.ts';
import { solutionTemplate } from './templates.ts';

const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

/**
 * puzzle title from the database, asking the provider (and storing the answer) on first use
 */
export const getTitle = async (source: Source, group: string, puzzle: number): Promise<string | null> => {
    const stored = getStoredTitle(source, group, puzzle);
    if (stored) return stored;
    if (!source.provider.fetchTitle) return null;
    try {
        const title = await source.provider.fetchTitle(await providerContext(source), group, puzzle);
        if (title) storeTitle(source, group, puzzle, title);
        return title;
    } catch {
        return null; // no credential, offline, not released: the puzzle simply has no title yet
    }
};

export interface PuzzleStatus {
    hasSolution: boolean;
    /** true when at least one input file is present */
    hasInput: boolean;
    /** per part (a single entry when the source has one shared input) */
    inputs: boolean[];
    hasReadme: boolean;
    hasDescription: boolean;
}

export const getPuzzleStatus = async (source: Source, group: string, puzzle: number): Promise<PuzzleStatus> => {
    const paths = puzzlePaths(source, group, puzzle);
    const inputParts = source.perPartInput ? range(source.parts) : [1];
    const [hasSolution, hasReadme, hasDescription, ...inputs] = await Promise.all([
        exists(paths.solution),
        exists(paths.readme),
        exists(paths.description),
        ...inputParts.map((part) => exists(paths.input(part))),
    ]);
    return { hasSolution, hasInput: inputs.some(Boolean), inputs, hasReadme, hasDescription };
};

export class PuzzleNotGeneratedError extends Error {
    constructor(source: Source, group: string, puzzle: number) {
        super(`${source.name} ${group} ${source.labels.puzzle} ${puzzle} has no solution file yet: fetch it first`);
        this.name = 'PuzzleNotGeneratedError';
    }
}

const writeInputs = async (source: Source, group: string, puzzle: number, inputs: Record<number, string>): Promise<void> => {
    const paths = puzzlePaths(source, group, puzzle);
    for (const [key, text] of Object.entries(inputs)) {
        const path = paths.input(Number(key) || 1); // key 0 is the shared input
        await ensureDir(parentOf(path));
        await Deno.writeTextFile(path, text);
    }
};

/**
 * downloads the inputs for a puzzle; throws when the provider cannot or the site refuses
 */
export const updateInputs = async (source: Source, group: string, puzzle: number): Promise<void> => {
    if (!source.provider.fetchInputs) throw new Error(`${source.provider.name} inputs cannot be downloaded: paste them into the input panel instead`);
    const inputs = await source.provider.fetchInputs(await providerContext(source), group, puzzle);
    await writeInputs(source, group, puzzle, inputs);
    await syncSolved(source, group, puzzle);
};

/**
 * records the answers the site has already accepted (solved there, or before the hub existed) so the stars match.
 * best effort: returns how many were new.
 */
export const syncSolved = async (source: Source, group: string, puzzle: number): Promise<number> => {
    if (!source.provider.fetchSolved) return 0;
    let added = 0;
    try {
        const solved = await source.provider.fetchSolved(await providerContext(source), group, puzzle);
        for (const [part, answer] of Object.entries(solved)) {
            if (Number(part) > source.parts || findAnswer(source, group, puzzle, Number(part), answer)?.correct === 1) continue;
            insertAnswer(source, group, puzzle, Number(part), answer, true);
            added++;
        }
    } catch {
        // not logged in, offline: nothing to record
    }
    return added;
};

// ---- puzzle text -----------------------------------------------------------

export interface PuzzleDescription {
    /** the text itself, in the format named below */
    markdown: string;
    parts: number;
    fetchedAt: string | null;
    format: 'markdown' | 'html';
}

const parseDescription = (content: string): PuzzleDescription => {
    const meta = content.match(/^<!-- fetched (\S+) from \S* ?\((\d+) parts?(, html)?\) -->\n*/);
    return {
        markdown: meta ? content.slice(meta[0].length) : content,
        parts: meta ? Number(meta[2]) : 1,
        fetchedAt: meta ? meta[1] : null,
        format: meta?.[3] ? 'html' : 'markdown',
    };
};

/**
 * downloads the puzzle text and stores it next to the solution; null when the provider has none (yet)
 */
export const fetchDescription = async (source: Source, group: string, puzzle: number): Promise<PuzzleDescription | null> => {
    if (!source.provider.fetchDescription) return null;
    const fetched = await source.provider.fetchDescription(await providerContext(source), group, puzzle);
    if (!fetched) return null;
    const paths = puzzlePaths(source, group, puzzle);
    await ensureDir(parentOf(paths.description));
    const shape = `${fetched.parts} part${fetched.parts === 1 ? '' : 's'}${fetched.format === 'html' ? ', html' : ''}`;
    const header = `<!-- fetched ${new Date().toISOString()} from ${source.provider.puzzleUrl(group, puzzle)} (${shape}) -->\n\n`;
    await Deno.writeTextFile(paths.description, header + fetched.markdown);
    return parseDescription(header + fetched.markdown);
};

export const readDescription = async (source: Source, group: string, puzzle: number): Promise<PuzzleDescription | null> => {
    const content = await readTextOrNull(puzzlePaths(source, group, puzzle).description);
    return content === null ? null : parseDescription(content);
};

// ---- scaffolding -----------------------------------------------------------

/**
 * creates the puzzle folder, writes a fresh solution file (never overwriting an existing one), and downloads whatever
 * the provider offers: inputs and puzzle text. a failed download is reported, not fatal.
 */
export const scaffoldPuzzle = async (
    source: Source,
    group: string,
    puzzle: number,
): Promise<{ title: string | null; createdSolution: boolean; inputError: string | null }> => {
    const paths = puzzlePaths(source, group, puzzle);
    await ensureDir(paths.directory);

    const title = await getTitle(source, group, puzzle);

    let createdSolution = false;
    if (!(await exists(paths.solution))) {
        await ensureDir(parentOf(paths.solution));
        await Deno.writeTextFile(paths.solution, await solutionTemplate(source, group, puzzle, title ?? 'untitled'));
        createdSolution = true;
    }

    let inputError: string | null = null;
    try {
        await updateInputs(source, group, puzzle);
    } catch (error) {
        inputError = error instanceof Error ? error.message : String(error);
    }

    try {
        await fetchDescription(source, group, puzzle);
    } catch {
        // puzzle text is a nicety
    }

    return { title, createdSolution, inputError };
};

// ---- file access -----------------------------------------------------------

export const readSolution = (source: Source, group: string, puzzle: number) => readTextOrNull(puzzlePaths(source, group, puzzle).solution);
export const readReadme = (source: Source, group: string, puzzle: number) => readTextOrNull(puzzlePaths(source, group, puzzle).readme);
export const readInput = (source: Source, group: string, puzzle: number, part: number) => readTextOrNull(puzzlePaths(source, group, puzzle).input(part));

const writeFile = async (path: string, content: string) => {
    await ensureDir(parentOf(path));
    await Deno.writeTextFile(path, content);
};

export const writeSolution = (source: Source, group: string, puzzle: number, code: string) => writeFile(puzzlePaths(source, group, puzzle).solution, code);
export const writeReadme = (source: Source, group: string, puzzle: number, content: string) => writeFile(puzzlePaths(source, group, puzzle).readme, content);
export const writeInput = (source: Source, group: string, puzzle: number, part: number, content: string) =>
    writeFile(puzzlePaths(source, group, puzzle).input(part), content);

// ---- listings --------------------------------------------------------------

export interface GroupSummary {
    id: string;
    label: string;
    puzzles: number[];
    stars: number;
    maxStars: number;
}

export const listGroups = async (source: Source): Promise<GroupSummary[]> => {
    const stars = getStarsByGroup(source);
    return (await listGroupInfos(source)).map((group) => ({ ...group, stars: stars.get(group.id) ?? 0, maxStars: group.puzzles.length * source.parts }));
};

export interface PuzzleSummary extends PuzzleStatus {
    puzzle: number;
    title: string | null;
    stars: number;
}

/**
 * overview of a group using only local data (no network calls)
 */
export const listGroup = async (source: Source, group: string): Promise<PuzzleSummary[]> => {
    const info = (await listGroupInfos(source)).find((candidate) => candidate.id === group);
    if (!info) return [];
    const titles = getTitlesForGroup(source, group);
    const stars = getStarsForGroup(source, group);
    return Promise.all(info.puzzles.map(async (puzzle) => ({
        puzzle,
        title: titles.get(puzzle) ?? null,
        stars: stars.get(puzzle) ?? 0,
        ...(await getPuzzleStatus(source, group, puzzle)),
    })));
};

/**
 * everything the frontend needs to show a single puzzle
 */
export const getPuzzleDetail = async (source: Source, group: string, puzzle: number) => {
    const [title, status, readme] = await Promise.all([
        getTitle(source, group, puzzle),
        getPuzzleStatus(source, group, puzzle),
        readReadme(source, group, puzzle),
    ]);
    return {
        source: source.id,
        group,
        puzzle,
        title,
        url: source.provider.puzzleUrl(group, puzzle),
        stars: getStars(source, group, puzzle),
        ...status,
        readme,
        answers: getAnswers(source, group, puzzle),
        runs: getRuns(source, group, puzzle),
    };
};
