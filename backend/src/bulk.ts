/**
 * backend/src/bulk.ts
 *
 * one-at-a-time background job that downloads inputs (and puzzle text) for every published puzzle of a source
 */

import { MissingCredentialError, RejectedCredentialError } from './providers/mod.ts';
import { fetchDescription, getPuzzleStatus, getTitle, updateInputs } from './puzzles.ts';
import { listGroupInfos, type Source } from './sources.ts';

export interface BulkOptions {
    onlyMissing: boolean; // skip puzzles that already have the files
    inputs: boolean;
    descriptions: boolean;
}

export interface BulkStatus {
    running: boolean;
    source: string | null;
    total: number;
    done: number;
    downloaded: number;
    skipped: number;
    current: string | null;
    errors: string[];
    startedAt: string | null;
    finishedAt: string | null;
    options: BulkOptions | null;
}

/** small pause between requests so we don't hammer the site */
const DELAY_MS = 300;

let status: BulkStatus = {
    running: false,
    source: null,
    total: 0,
    done: 0,
    downloaded: 0,
    skipped: 0,
    current: null,
    errors: [],
    startedAt: null,
    finishedAt: null,
    options: null,
};

export const getBulkStatus = (): BulkStatus => ({ ...status, errors: [...status.errors] });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** a download followed by the pause, whether it worked or not: a failing job must not hammer the site either */
const politely = async (download: () => Promise<unknown>): Promise<void> => {
    try {
        await download();
    } finally {
        await sleep(DELAY_MS);
    }
};

const runJob = async (source: Source, options: BulkOptions, onProgress?: (status: BulkStatus) => void) => {
    const puzzles = (await listGroupInfos(source)).flatMap((group) => group.puzzles.map((puzzle) => ({ group: group.id, puzzle })));
    status.total = puzzles.length;

    let credentialFailed = false;

    for (const { group, puzzle } of puzzles) {
        status.current = `${group} ${source.labels.puzzle} ${puzzle}`;
        onProgress?.(getBulkStatus());
        try {
            const current = await getPuzzleStatus(source, group, puzzle);
            let touched = false;

            if (options.inputs && source.provider.fetchInputs && (!options.onlyMissing || current.inputs.some((present) => !present))) {
                await politely(() => updateInputs(source, group, puzzle));
                touched = true;
            }
            if (options.descriptions && source.provider.fetchDescription && (!options.onlyMissing || !current.hasDescription)) {
                await politely(async () => {
                    await fetchDescription(source, group, puzzle);
                    await getTitle(source, group, puzzle);
                });
                touched = true;
            }

            if (touched) status.downloaded++;
            else status.skipped++;
        } catch (error) {
            status.errors.push(`${status.current}: ${error instanceof Error ? error.message : String(error)}`);
            // a missing or rejected credential fails every other puzzle the same way: stop asking the site
            credentialFailed = error instanceof MissingCredentialError || error instanceof RejectedCredentialError;
        }
        status.done++;

        if (credentialFailed) {
            const left = puzzles.length - status.done;
            if (left > 0) status.errors.push(`stopped with ${left} puzzle${left === 1 ? '' : 's'} left: fix the credential, then start again`);
            break;
        }
    }

    status.running = false;
    status.current = null;
    status.finishedAt = new Date().toISOString();
    onProgress?.(getBulkStatus());
};

/**
 * starts the download in the background; returns false when one is already running
 */
export const startBulkDownload = (source: Source, options: Partial<BulkOptions> = {}, onProgress?: (status: BulkStatus) => void): boolean => {
    if (status.running) return false;

    const resolved: BulkOptions = { onlyMissing: true, inputs: true, descriptions: true, ...options };
    status = {
        running: true,
        source: source.id,
        total: 0,
        done: 0,
        downloaded: 0,
        skipped: 0,
        current: null,
        errors: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
        options: resolved,
    };

    runJob(source, resolved, onProgress).catch((error) => {
        status.errors.push(error instanceof Error ? error.message : String(error));
        status.running = false;
        status.finishedAt = new Date().toISOString();
    });
    return true;
};

/**
 * runs the download to completion (for the cli)
 */
export const bulkDownload = async (source: Source, options: Partial<BulkOptions> = {}, onProgress?: (status: BulkStatus) => void): Promise<BulkStatus> => {
    if (!startBulkDownload(source, options, onProgress)) throw new Error('a bulk download is already running');
    while (status.running) await sleep(200);
    return getBulkStatus();
};
