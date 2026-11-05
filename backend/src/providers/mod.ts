/**
 * backend/src/providers/mod.ts
 *
 * a provider is everything the hub needs to know about one puzzle site: how its puzzles are grouped and numbered,
 * and (optionally) how to download inputs and text and how to submit answers. the rest of the hub is site agnostic.
 */

import { adventOfCode } from './advent-of-code.ts';
import { aquaq } from './aquaq.ts';
import { everybodyCodes } from './everybody-codes.ts';
import { manual } from './manual.ts';

export interface GroupInfo {
    /** used in folder names and urls, e.g. "2024" or "event2024" */
    id: string;
    label: string;
    /** puzzle numbers in this group (not always starting at 1) */
    puzzles: number[];
}

export interface ProviderContext {
    /** the credential the user stored for this provider ('' when none) */
    session: string;
    /** identifies whoever runs this hub to the site */
    userAgent: string;
}

export interface FetchedDescription {
    markdown: string;
    /** how many parts of the text were available */
    parts: number;
}

/** what a site has published right now */
export interface Discovery {
    groups: GroupInfo[];
    /** titles that came with the listing, as group -> puzzle -> title */
    titles?: Record<string, Record<number, string>>;
    /** ask again sooner than the usual day, e.g. while an event is running */
    maxAgeMs?: number;
}

export type SubmitResult = 'correct' | 'incorrect' | 'too-soon' | 'already-solved' | 'unknown';

export interface Provider {
    id: string;
    name: string;
    home: string;
    /** what a group and a puzzle are called on this site ('' when there is only one group) */
    labels: { group: string; puzzle: string };
    /** parts per puzzle */
    parts: number;
    /** true when every part has its own input file */
    perPartInput: boolean;
    /** the secret needed for downloads, or null when the site needs none / the provider is offline */
    credential: { label: string; hint: string } | null;
    /** groups and puzzles the site is known to have: the fallback for sites that cannot be asked (see discover) */
    groups(now?: Date): GroupInfo[];
    /**
     * asks the site which groups and puzzles exist right now, so new ones show up without a hub update.
     * called at most about once a day; the answer replaces groups() and is cached (the previous answer is passed in
     * so parts that cannot change need not be asked again). null = could not tell.
     */
    discover?(context: ProviderContext, now?: Date, previous?: Discovery | null): Promise<Discovery | null>;
    /** puzzles a calendar says are out right now, added on top of the last answer from the site */
    released?(now?: Date): GroupInfo[];
    puzzleUrl(group: string, puzzle: number): string;
    /** the puzzle that was released today, if the site publishes on a calendar (used as the cli default) */
    current?(now: Date): { group: string; puzzle: number } | null;
    /** first line of a generated readme */
    heading(group: string, puzzle: number, title: string): string;
    fetchTitle?(context: ProviderContext, group: string, puzzle: number): Promise<string | null>;
    /** inputs keyed by part; key 0 is the single shared input when perPartInput is false */
    fetchInputs?(context: ProviderContext, group: string, puzzle: number): Promise<Record<number, string>>;
    fetchDescription?(context: ProviderContext, group: string, puzzle: number): Promise<FetchedDescription | null>;
    submit?(context: ProviderContext, group: string, puzzle: number, part: number, answer: string): Promise<SubmitResult>;
}

/** thrown when a download needs a credential that has not been stored */
export class MissingCredentialError extends Error {
    constructor(provider: Provider) {
        super(`no ${provider.credential?.label ?? 'credential'} stored for ${provider.name}: set it in the settings panel or with the cli 'session' command`);
        this.name = 'MissingCredentialError';
    }
}

export const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);

const PROVIDERS: Record<string, Provider> = {
    [adventOfCode.id]: adventOfCode,
    [everybodyCodes.id]: everybodyCodes,
    [aquaq.id]: aquaq,
    [manual.id]: manual,
};

export const getProvider = (id: string): Provider | null => PROVIDERS[id] ?? null;
export const providerIds = (): string[] => Object.keys(PROVIDERS);
