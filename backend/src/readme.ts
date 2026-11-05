/**
 * backend/src/readme.ts
 *
 * renders the results header of a puzzle readme while preserving the writeup after the %%% marker
 */

import type { Source } from './sources.ts';

/** separates the generated results header from the hand written writeup */
export const WRITEUP_MARKER = '%%%';

export type ReadmeResults = Record<string, { answer: string; timeMs: number } | undefined>;

/**
 * builds the readme: generated header + results table, then whatever writeup the existing readme already had
 */
export const renderReadme = (source: Source, group: string, puzzle: number, title: string, results: ReadmeResults, existing?: string): string => {
    const parts = Array.from({ length: source.parts }, (_, index) => index + 1);
    const cell = (part: number, field: 'answer' | 'time') => {
        const result = results[`part${part}`];
        if (!result) return 'n/a';
        return field === 'answer' ? result.answer : result.timeMs.toFixed(2);
    };

    const header = `${source.provider.heading(group, puzzle, title)}

## Results

|                  | ${parts.map((part) => `**Part ${part}**`).join(' | ')} |
| :--------------: | ${parts.map(() => ':--------:').join(' | ')} |
|   **Results**    | ${parts.map((part) => cell(part, 'answer')).join(' | ')} |
| **Time (in ms)** | ${parts.map((part) => cell(part, 'time')).join(' | ')} |
`;

    const writeup = existing ? extractWriteup(existing) : null;
    return writeup ? `${header}\n${writeup}\n` : header;
};

/**
 * the hand written part of a readme, starting with the marker. readmes written before the marker existed keep
 * whatever follows their results table (the marker is added), so profiling never eats a writeup.
 */
export const extractWriteup = (existing: string): string | null => {
    const index = existing.indexOf(WRITEUP_MARKER);
    if (index !== -1) return existing.slice(index).trimEnd();

    const lines = existing.split('\n');
    const results = lines.findIndex((line) => /^#+\s*results\s*$/i.test(line.trim()));
    if (results === -1) return null;
    let end = results + 1;
    let seenTable = false;
    for (; end < lines.length; end++) {
        const line = lines[end].trim();
        if (line.startsWith('|')) seenTable = true;
        else if (line !== '' && !(!seenTable && /^answer\s*:/i.test(line))) break;
        else if (line === '' && seenTable) break;
    }
    const rest = lines.slice(end).join('\n').trim();
    return rest ? `${WRITEUP_MARKER}\n\n${rest}` : null;
};

/** title and answers recorded in a readme's generated header, for adopting repositories that predate the hub */
export const parseReadme = (readme: string): { title: string | null; answers: Record<number, string> } => {
    const heading = readme.split('\n').find((line) => line.startsWith('# ')) ?? '';
    const linked = heading.match(/\[(.+)\]\([^)]*\)\s*$/);
    const plain = heading.match(/:\s*(.+?)\s*$/);
    const title = (linked?.[1] ?? plain?.[1] ?? '').trim() || null;

    const answers: Record<number, string> = {};
    const empty = (value: string) => value === '' || /^n\/?a$/i.test(value) || value.startsWith('%') || value === '-';
    const row = readme.split('\n').find((line) => /^\|\s*\*\*Results?\*\*\s*\|/i.test(line.trim()));
    if (row) {
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').slice(1).forEach((cell, index) => {
            const value = cell.trim().replace(/^`(.*)`$/, '$1');
            if (!empty(value)) answers[index + 1] = value;
        });
    } else {
        const single = readme.match(/^Answer:\s*(.+?)\s*$/im)?.[1] ?? '';
        if (!empty(single)) answers[1] = single;
    }
    return { title, answers };
};
