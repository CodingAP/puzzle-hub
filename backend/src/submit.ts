/**
 * backend/src/submit.ts
 *
 * runs a puzzle and submits the answers, remembering every verdict so nothing is resubmitted by accident.
 * submitting every part sends at most one new answer per call: parts that are already settled are passed over, the
 * first one that is not is submitted, and the parts after it wait for the next call (a part that is not written yet
 * would only earn a wrong-answer lockout).
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

/** one part's outcome; last = nothing may be sent after it in this call (only a part that was solved before lets the next one through) */
interface PartStep {
    outcome: SubmitPartOutcome;
    last: boolean;
}

const submitPart = async (source: Source, group: string, puzzle: number, part: number, answer: string, record: boolean): Promise<PartStep> => {
    const previous = findAnswer(source, group, puzzle, part, answer);
    if (previous) {
        const outcome = previous.correct === 1
            ? { answer, correct: true, message: "🎉 already recorded: that's the right answer!" }
            : { answer, correct: false, message: "❌ already recorded: that's not the right answer." };
        // an answer known to be wrong leaves the part unsolved, so the next part cannot have a real answer yet
        return { outcome, last: previous.correct !== 1 };
    }

    if (record) {
        insertAnswer(source, group, puzzle, part, answer, true);
        return { outcome: { answer, correct: true, message: 'recorded as correct without contacting the site' }, last: true };
    }

    if (!source.provider.submit) {
        const message = `${source.provider.name} answers cannot be submitted from here: check it on the site, then record it`;
        return { outcome: { answer, correct: null, message }, last: false };
    }

    const verdict = await source.provider.submit(await providerContext(source), group, puzzle, part, answer);
    let correct: boolean | null = null;
    let message: string;
    switch (verdict) {
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
    return { outcome: { answer, correct, message }, last: verdict !== 'already-solved' };
};

/**
 * computes the requested part(s) and submits the first one that is not settled yet; the parts after it are reported
 * as not submitted. record = true stores the answer as correct without contacting the site.
 */
export const submitAnswer = async (source: Source, group: string, puzzle: number, part: PartSpec = 'all', record = false): Promise<SubmitOutcome> => {
    const run = await runPuzzle(source, group, puzzle, { part, iterations: 1 });
    if (!run.success) throw new Error(`solution failed, nothing submitted: ${run.error}`);

    const outcome: SubmitOutcome = {};
    /** the part this call stopped at (submitted, recorded, or known to be wrong): nothing is sent after it */
    let sent: { part: number; correct: boolean | null } | null = null;
    for (let current = 1; current <= source.parts; current++) {
        const result = run.results[`part${current}`];
        if (!result) continue;
        if (sent) {
            const message = sent.correct
                ? `not submitted: part ${sent.part} went first, submit again for this part`
                : `not submitted: submit again once part ${sent.part} is solved`;
            outcome[`part${current}`] = { answer: result.answer, correct: null, message };
            continue;
        }
        const step = await submitPart(source, group, puzzle, current, result.answer, record);
        outcome[`part${current}`] = step.outcome;
        if (step.last) sent = { part: current, correct: step.outcome.correct };
    }
    return outcome;
};
