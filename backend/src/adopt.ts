/**
 * backend/src/adopt.ts
 *
 * brings a repository that was solved before it had a hub database up to date: puzzle titles and the answers
 * recorded in each readme's results table are stored (as correct), so the dashboard shows the right stars
 */

import { findAnswer, getStoredTitle, insertAnswer, storeTitle } from './db.ts';
import { readReadme } from './puzzles.ts';
import { parseReadme } from './readme.ts';
import { listGroupInfos, type Source } from './sources.ts';

export interface AdoptResult {
    puzzles: number;
    titles: number;
    answers: number;
}

export const adoptReadmes = async (source: Source): Promise<AdoptResult> => {
    const result: AdoptResult = { puzzles: 0, titles: 0, answers: 0 };
    for (const group of await listGroupInfos(source)) {
        for (const puzzle of group.puzzles) {
            const readme = await readReadme(source, group.id, puzzle);
            if (readme === null) continue;
            result.puzzles++;
            const { title, answers } = parseReadme(readme);
            if (title && !getStoredTitle(source, group.id, puzzle)) {
                storeTitle(source, group.id, puzzle, title);
                result.titles++;
            }
            for (const [part, answer] of Object.entries(answers)) {
                if (Number(part) > source.parts || findAnswer(source, group.id, puzzle, Number(part), answer)) continue;
                insertAnswer(source, group.id, puzzle, Number(part), answer, true);
                result.answers++;
            }
        }
    }
    return result;
};
