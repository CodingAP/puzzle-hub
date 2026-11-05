/**
 * backend/src/examples.ts
 *
 * saved example inputs (with optional expected answers) for a puzzle, kept next to the solution
 */

import { ensureDir, readTextOrNull } from './fs.ts';
import { puzzlePaths, type Source } from './sources.ts';

export interface Example {
    name: string;
    input: string;
    /** expected answers keyed part1, part2, … */
    expected?: Record<string, string>;
}

const MAX_EXAMPLES = 50;
const MAX_INPUT_LENGTH = 1_000_000;

const isExample = (value: unknown): value is Example => {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.name === 'string' && typeof candidate.input === 'string';
};

export const readExamples = async (source: Source, group: string, puzzle: number): Promise<Example[]> => {
    const raw = await readTextOrNull(puzzlePaths(source, group, puzzle).examples);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isExample) : [];
    } catch {
        return [];
    }
};

export const writeExamples = async (source: Source, group: string, puzzle: number, examples: Example[]): Promise<void> => {
    const paths = puzzlePaths(source, group, puzzle);
    await ensureDir(paths.directory);
    await Deno.writeTextFile(paths.examples, JSON.stringify(examples, null, 4) + '\n');
};

/**
 * validates a request body into a clean list of examples; throws a message suitable for a 400
 */
export const sanitizeExamples = (value: unknown, parts: number): Example[] => {
    if (!Array.isArray(value)) throw new Error('examples must be an array');
    if (value.length > MAX_EXAMPLES) throw new Error(`at most ${MAX_EXAMPLES} examples per puzzle`);
    return value.map((entry, index) => {
        if (!isExample(entry)) throw new Error(`example ${index + 1} needs a name and an input`);
        if (entry.input.length > MAX_INPUT_LENGTH) throw new Error(`example ${index + 1} is too large`);
        const expected: Record<string, string> = {};
        const given = (entry.expected ?? {}) as Record<string, unknown>;
        for (let part = 1; part <= parts; part++) {
            const answer = given[`part${part}`];
            if (answer !== undefined && answer !== null && String(answer).trim() !== '') expected[`part${part}`] = String(answer).trim();
        }
        return { name: entry.name.trim() || `example ${index + 1}`, input: entry.input, ...(Object.keys(expected).length ? { expected } : {}) };
    });
};
