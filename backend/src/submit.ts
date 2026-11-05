/**
 * backend/src/submit.ts
 *
 * runs a puzzle and submits the answers, remembering every verdict so nothing is resubmitted by accident.
 * providers that cannot submit still let you record an answer you checked on the site yourself.
 */

import type { PartSpec } from './config.ts';
import { findAnswer, insertAnswer } from './db.ts';
import { runPuzzle } from './runner.ts';
import { providerContext, type Source } from './sources.ts';

export interface SubmitPartOutcome {
    answer: string;
    message: string;
    correct: boolean | null;
}

/** keyed part1, part2, … */
export type SubmitOutcome = Record<string, SubmitPartOutcome>;

/** sites reject a second submission within a few seconds of the first */
const SUBMISSION_DELAY_MS = 5000;

const submitPart = async (source: Source, group: string, puzzle: number, part: number, answer: string, record: boolean): Promise<SubmitPartOutcome> => {
    const previous = findAnswer(source, group, puzzle, part, answer);
    if (previous) {
        return previous.correct === 1
            ? { answer, correct: true, message: "🎉 already recorded: that's the right answer!" }
            : { answer, correct: false, message: "❌ already recorded: that's not the right answer." };
    }

    if (record) {
        insertAnswer(source, group, puzzle, part, answer, true);
        return { answer, correct: true, message: 'recorded as correct without contacting the site' };
    }

    if (!source.provider.submit) {
        return { answer, correct: null, message: `${source.provider.name} answers cannot be submitted from here: check it on the site, then record it` };
    }

    const outcome = await source.provider.submit(await providerContext(source), group, puzzle, part, answer);
    let correct: boolean | null = null;
    let message: string;
    switch (outcome) {
        case 'correct':
            correct = true;
            message = "🎉 submission successful: that's the right answer!";
            break;
        case 'incorrect':
            correct = false;
            message = "❌ submission failed: that's not the right answer.";
            break;
        case 'too-soon':
            message = '⏳ submission failed: you are submitting too quickly.';
            break;
        case 'already-solved':
            message = '❓ submission failed: already solved.';
            break;
        default:
            message = '⚠️ submission failed: unknown response from the site.';
    }

    // only definite verdicts are worth remembering
    if (correct !== null) insertAnswer(source, group, puzzle, part, answer, correct);
    return { answer, correct, message };
};

/**
 * computes and submits the requested part(s); record = true stores the answers as correct without contacting the site
 */
export const submitAnswer = async (source: Source, group: string, puzzle: number, part: PartSpec = 'all', record = false): Promise<SubmitOutcome> => {
    const run = await runPuzzle(source, group, puzzle, { part, iterations: 1 });
    if (!run.success) throw new Error(`solution failed, nothing submitted: ${run.error}`);

    const outcome: SubmitOutcome = {};
    let first = true;
    for (let current = 1; current <= source.parts; current++) {
        const result = run.results[`part${current}`];
        if (!result) continue;
        if (!first && !record && source.provider.submit) await new Promise((resolve) => setTimeout(resolve, SUBMISSION_DELAY_MS));
        outcome[`part${current}`] = await submitPart(source, group, puzzle, current, result.answer, record);
        first = false;
    }
    return outcome;
};
