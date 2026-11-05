/**
 * backend/src/sources.ts
 *
 * a source is a mounted repository of puzzle solutions described by a puzzlehub.json manifest at its root.
 * everything the hub does to files goes through the paths resolved here.
 */

import { type HubConfig, loadHubConfig } from './config.ts';
import { discoveredGroups } from './discovery.ts';
import { exists, join, readTextOrNull } from './fs.ts';
import { getProvider, type GroupInfo, type Provider, type ProviderContext, providerIds } from './providers/mod.ts';
import { getCredential } from './session.ts';

export const MANIFEST_FILE = 'puzzlehub.json';

export interface Layout {
    /** folder of one puzzle relative to the source root; placeholders {group}, {puzzle}, {puzzle:2} (zero padded) */
    puzzle: string;
    solution: string;
    readme: string;
    /** may contain {part} when every part has its own input */
    input: string;
    description: string;
    examples: string;
}

export interface RunnerConfig {
    /** module: a ts/js file whose exports are called in a sandboxed deno subprocess. command: any program that prints the answer */
    kind: 'module' | 'command';
    /** export name per part, e.g. "part{part}" or "solution" (module kind) */
    exports?: string;
    /** argv with {solution} {input} {part} {dir} placeholders (command kind) */
    command?: string[];
}

export interface Manifest {
    id: string;
    name?: string;
    provider: string;
    /** web url of the repository, used for "source" links */
    repository?: string;
    layout: Partial<Layout> & { puzzle: string };
    parts?: number;
    runner?: RunnerConfig;
    /** sqlite file with titles, answers and run history, relative to the source root */
    data?: string;
    /** extra or overriding groups: [{ "id": "2024", "label": "2024", "puzzles": 25 }] */
    groups?: { id: string; label?: string; puzzles?: number | number[] }[];
    /** solution template with %TITLE% %PATH% %DATE% %GROUP% %PUZZLE% placeholders */
    template?: string;
    labels?: { group?: string; puzzle?: string };
    /** what profiling publishes with git (default: the puzzle folder and the data file) */
    publish?: { enabled?: boolean; data?: boolean };
}

export interface Source {
    id: string;
    name: string;
    root: string;
    manifest: Manifest;
    provider: Provider;
    parts: number;
    perPartInput: boolean;
    labels: { group: string; puzzle: string };
    layout: Layout;
    runner: RunnerConfig;
    dataPath: string;
    repository: string | null;
}

export class SourceError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
        this.name = 'SourceError';
    }
}

const SAFE_GROUP = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const buildSource = (root: string, manifest: Manifest): Source => {
    if (!manifest.id || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) throw new Error(`${root}: manifest "id" must be lower case letters, digits and dashes`);
    const provider = getProvider(manifest.provider);
    if (!provider) throw new Error(`${root}: unknown provider '${manifest.provider}' (available: ${providerIds().join(', ')})`);
    if (!manifest.layout?.puzzle?.includes('{puzzle')) throw new Error(`${root}: manifest "layout.puzzle" must contain {puzzle}`);

    const layout: Layout = {
        puzzle: manifest.layout.puzzle,
        solution: manifest.layout.solution ?? 'solution.ts',
        readme: manifest.layout.readme ?? 'README.md',
        input: manifest.layout.input ?? (provider.perPartInput ? 'inputs/input{part}.txt' : 'input.txt'),
        description: manifest.layout.description ?? 'puzzle.md',
        examples: manifest.layout.examples ?? 'examples.json',
    };
    const runner: RunnerConfig = manifest.runner ?? { kind: 'module', exports: 'part{part}' };
    if (runner.kind === 'command' && !runner.command?.length) throw new Error(`${root}: a command runner needs "command"`);

    return {
        id: manifest.id,
        name: manifest.name ?? provider.name,
        root,
        manifest,
        provider,
        parts: manifest.parts ?? provider.parts,
        perPartInput: layout.input.includes('{part}'),
        labels: { group: manifest.labels?.group ?? provider.labels.group, puzzle: manifest.labels?.puzzle ?? provider.labels.puzzle },
        layout,
        runner,
        dataPath: join(root, manifest.data ?? 'hub.db'),
        repository: manifest.repository ?? null,
    };
};

let hubConfig: HubConfig | null = null;
let sources: Source[] | null = null;

export const getHubConfig = async (): Promise<HubConfig> => (hubConfig ??= await loadHubConfig());

/**
 * reads every mounted source's manifest (once); a broken source is reported and skipped rather than taking the hub down
 */
export const loadSources = async (reload = false): Promise<Source[]> => {
    if (sources && !reload) return sources;
    if (reload) hubConfig = null;
    const config = await getHubConfig();
    const loaded: Source[] = [];
    for (const root of config.sources) {
        const raw = await readTextOrNull(join(root, MANIFEST_FILE));
        if (!raw) {
            console.error(`skipping ${root}: no ${MANIFEST_FILE}`);
            continue;
        }
        try {
            const source = buildSource(root, JSON.parse(raw));
            if (loaded.some((other) => other.id === source.id)) throw new Error(`${root}: duplicate source id '${source.id}'`);
            loaded.push(source);
        } catch (error) {
            console.error(`skipping source: ${error instanceof Error ? error.message : error}`);
        }
    }
    sources = loaded;
    return loaded;
};

export const getSource = async (id: string): Promise<Source> => {
    const source = (await loadSources()).find((candidate) => candidate.id === id);
    if (!source) throw new SourceError(`unknown source '${id}'`, 404);
    return source;
};

/** what a provider needs to talk to its site on behalf of this hub's user */
export const providerContext = async (source: Source): Promise<ProviderContext> => ({
    session: await getCredential(source.provider.id),
    userAgent: (await getHubConfig()).contact,
});

// ---- paths -----------------------------------------------------------------

const expand = (pattern: string, values: { group?: string; puzzle?: number; part?: number }): string =>
    pattern.replace(/\{(group|puzzle|part)(?::(\d+))?\}/g, (_match, name: 'group' | 'puzzle' | 'part', width?: string) => {
        const value = String(values[name] ?? '');
        return width ? value.padStart(Number(width), '0') : value;
    });

export interface PuzzlePaths {
    directory: string;
    solution: string;
    readme: string;
    description: string;
    examples: string;
    /** part is ignored when the source has one shared input */
    input(part: number): string;
}

export const puzzlePaths = (source: Source, group: string, puzzle: number): PuzzlePaths => {
    const directory = join(source.root, expand(source.layout.puzzle, { group, puzzle }));
    return {
        directory,
        solution: join(directory, source.layout.solution),
        readme: join(directory, source.layout.readme),
        description: join(directory, source.layout.description),
        examples: join(directory, source.layout.examples),
        input: (part: number) => join(directory, expand(source.layout.input, { group, puzzle, part })),
    };
};

// ---- groups ----------------------------------------------------------------

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** folders that match the layout pattern, as group -> puzzle numbers */
const discover = async (source: Source): Promise<Map<string, Set<number>>> => {
    const found = new Map<string, Set<number>>();
    const segments = source.layout.puzzle.split('/').filter(Boolean).map((segment) =>
        new RegExp(
            '^' + escapeRegex(segment)
                .replace(/\\\{group\\\}/g, '(?<group>[A-Za-z0-9][A-Za-z0-9_.-]*)')
                .replace(/\\\{puzzle(?::\d+)?\\\}/g, '(?<puzzle>\\d+)') +
                '$',
        )
    );
    const fallbackGroup = source.manifest.groups?.[0]?.id ?? source.provider.groups()[0]?.id ?? 'all';

    const walk = async (directory: string, index: number, group: string | undefined, puzzle: number | undefined) => {
        if (index === segments.length) {
            if (puzzle === undefined) return;
            const key = group ?? fallbackGroup;
            if (!found.has(key)) found.set(key, new Set());
            found.get(key)!.add(puzzle);
            return;
        }
        try {
            for await (const entry of Deno.readDir(directory)) {
                if (!entry.isDirectory) continue;
                const match = entry.name.match(segments[index]);
                if (!match) continue;
                await walk(
                    join(directory, entry.name),
                    index + 1,
                    match.groups?.group ?? group,
                    match.groups?.puzzle !== undefined ? Number(match.groups.puzzle) : puzzle,
                );
            }
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
    };
    await walk(source.root, 0, undefined, undefined);
    return found;
};

/**
 * the groups of a source: what the site (or failing that the provider) says exists, adjusted by the manifest, plus anything found on disk
 */
export const listGroupInfos = async (source: Source): Promise<GroupInfo[]> => {
    const groups = new Map<string, GroupInfo>();
    const order: string[] = [];
    const upsert = (id: string, label: string | undefined, puzzles: number[]) => {
        const existing = groups.get(id);
        if (!existing) {
            groups.set(id, { id, label: label ?? id, puzzles: [...puzzles] });
            order.push(id);
            return;
        }
        if (label) existing.label = label;
        existing.puzzles = [...new Set([...existing.puzzles, ...puzzles])].sort((a, b) => a - b);
    };

    // what the site says it has (asked now and then, cached), else what the provider knows by heart
    const discovered = await discoveredGroups(source);
    for (const group of discovered ?? source.provider.groups()) upsert(group.id, group.label, group.puzzles);
    // a puzzle released since the site was last asked
    if (discovered) { for (const group of source.provider.released?.() ?? []) upsert(group.id, group.label, group.puzzles); }
    for (const group of source.manifest.groups ?? []) {
        const puzzles = Array.isArray(group.puzzles)
            ? group.puzzles
            : typeof group.puzzles === 'number'
            ? Array.from({ length: group.puzzles }, (_, i) => i + 1)
            : [];
        if (groups.has(group.id) && puzzles.length) groups.get(group.id)!.puzzles = []; // the manifest overrides the provider's list
        upsert(group.id, group.label, puzzles);
    }
    for (const [id, puzzles] of await discover(source)) upsert(id, undefined, [...puzzles]);

    return order.map((id) => groups.get(id)!).filter((group) => group.puzzles.length > 0);
};

/**
 * validates a group / puzzle pair coming from outside before it is turned into a path
 */
export const assertPuzzle = async (source: Source, group: string, puzzle: number): Promise<void> => {
    if (!SAFE_GROUP.test(group) || group.includes('..')) throw new SourceError(`invalid ${source.labels.group || 'group'} '${group}'`);
    if (!Number.isInteger(puzzle) || puzzle < 0 || puzzle > 9999) throw new SourceError(`invalid ${source.labels.puzzle} '${puzzle}'`);
    const info = (await listGroupInfos(source)).find((candidate) => candidate.id === group);
    if (!info) throw new SourceError(`${source.name} has no ${source.labels.group || 'group'} '${group}'`);
    if (!info.puzzles.includes(puzzle)) {
        throw new SourceError(`${source.name}${source.labels.group ? ` ${group}` : ''} has no ${source.labels.puzzle} ${puzzle}`);
    }
};

export const sourceHasData = (source: Source): Promise<boolean> => exists(source.dataPath);
