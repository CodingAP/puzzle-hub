/**
 * frontend/src/state.ts
 *
 * the shared application state and the actions that change it
 */

import { api } from './api.ts';
import { settings } from './settings.ts';
import type { GroupSummary, Hub, Part, PuzzleDetail, PuzzleRef, RunHandlers, RunOutcome, SourceInfo, SubmitOutcome } from './types.ts';

export interface State {
    hub: Hub | null;
    /** groups (with star counts) of every source, keyed by source id */
    groups: Record<string, GroupSummary[]>;
    /** the puzzle open in the editor; null until the hub has told us what exists */
    puzzle: PuzzleRef | null;
    /** the source the dashboard is showing */
    dashboardSource: string | null;
    /** which page is on screen */
    view: 'dashboard' | 'editor';
    detail: PuzzleDetail | null;
    detailError: string | null;
    dirty: boolean;
    pendingCode: string | null;
    running: boolean;
    lastRun: RunOutcome | null;
    lastSubmit: SubmitOutcome | null;
    lastError: string | null;
}

export type StateKey = keyof State;
type Listener = (state: State, changed: Set<StateKey>) => void;

const listeners = new Set<Listener>();

let state: State = {
    hub: null,
    groups: {},
    puzzle: null,
    dashboardSource: null,
    view: 'dashboard',
    detail: null,
    detailError: null,
    dirty: false,
    pendingCode: null,
    running: false,
    lastRun: null,
    lastSubmit: null,
    lastError: null,
};

export const getState = (): State => state;

export const subscribe = (listener: Listener, keys?: StateKey[]): () => void => {
    const wrapped: Listener = keys ? (next, changed) => keys.some((key) => changed.has(key)) && listener(next, changed) : listener;
    listeners.add(wrapped);
    return () => listeners.delete(wrapped);
};

const update = (patch: Partial<State>) => {
    const changed = new Set<StateKey>();
    for (const key of Object.keys(patch) as StateKey[]) {
        if (patch[key] !== state[key]) changed.add(key);
    }
    if (changed.size === 0) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state, changed);
};

// ---- helpers shared by the panels ----------------------------------------------

export const refKey = (ref: PuzzleRef | null) => (ref ? `${ref.source}/${ref.group}/${ref.puzzle}` : '');
export const sameRef = (a: PuzzleRef | null, b: PuzzleRef | null) => refKey(a) === refKey(b);

export const sourceInfo = (id: string | null | undefined): SourceInfo | null => state.hub?.sources.find((source) => source.id === id) ?? null;

/** the source of the puzzle open in the editor */
export const activeSource = (): SourceInfo | null => sourceInfo(state.puzzle?.source);

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Day 4", "Quest 12", "Challenge 0" */
export const puzzleLabel = (source: SourceInfo | null, puzzle: number) => `${capitalise(source?.labels.puzzle || 'puzzle')} ${puzzle}`;

/** part1, part2, ... for a source */
export const partKeys = (source: SourceInfo | null): string[] => Array.from({ length: source?.parts ?? 2 }, (_, index) => `part${index + 1}`);

export const partName = (key: string) => key.replace('part', 'part ');

/** [value, label] pairs for a part <select>: every part, then each one */
export const partOptions = (source: SourceInfo | null): [string, string][] => {
    const parts = source?.parts ?? 2;
    if (parts === 1) return [['all', 'the puzzle']];
    return [
        ['all', parts === 2 ? 'both parts' : 'all parts'],
        ...Array.from({ length: parts }, (_, index): [string, string] => [String(index + 1), `part ${index + 1}`]),
    ];
};

/** a default part setting made for one source may not exist in another */
export const validPart = (source: SourceInfo | null, part: Part): Part => (partOptions(source).some(([value]) => value === part) ? part : 'all');

/** the platform on screen: the editor's puzzle decides there, the dashboard has its own */
export const shownSource = (): SourceInfo | null => sourceInfo(state.view === 'editor' ? state.puzzle?.source : state.dashboardSource);

/** somewhere sensible to start in a source: where you last were in it, else its newest group that has a solution, else its newest group */
export const firstPuzzle = (source: string): PuzzleRef | null => {
    const groups = state.groups[source] ?? [];
    const last = settings.get().lastBySource[source];
    if (last && groups.find((group) => group.id === last.group)?.puzzles.includes(last.puzzle)) return last;
    const group = [...groups].reverse().find((candidate) => candidate.stars > 0) ?? groups.at(-1);
    return group ? { source, group: group.id, puzzle: group.puzzles[0] } : null;
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const actions = {
    /** what this hub hosts; everything else waits for it */
    async loadHub(): Promise<void> {
        try {
            const hub = await api.hub();
            update({ hub, dashboardSource: sourceInfo(state.dashboardSource) ? state.dashboardSource : null });
            const remembered = settings.get().dashboardSource;
            if (!state.dashboardSource) update({ dashboardSource: hub.sources.find((source) => source.id === remembered)?.id ?? hub.sources[0]?.id ?? null });
            await this.loadGroups();
        } catch (error) {
            update({ lastError: errorMessage(error) });
        }
    },

    /** (re)loads the groups and star counts of one source, or of all of them */
    async loadGroups(source?: string): Promise<void> {
        const ids = source ? [source] : state.hub?.sources.map((entry) => entry.id) ?? [];
        try {
            const loaded = await Promise.all(ids.map(async (id) => [id, await api.groups(id)] as const));
            update({ groups: { ...state.groups, ...Object.fromEntries(loaded) } });
        } catch (error) {
            update({ lastError: errorMessage(error) });
        }
    },

    setDashboardSource(source: string): void {
        update({ dashboardSource: source });
        settings.set({ dashboardSource: source });
    },

    setView(view: State['view']): void {
        update({ view });
    },

    /**
     * switches puzzle (asking first when the editor has unsaved changes) and reloads its detail
     */
    async selectPuzzle(puzzle: PuzzleRef, { force = false } = {}): Promise<boolean> {
        if (!force && sameRef(puzzle, state.puzzle) && state.detail) return true;
        if (state.dirty && !sameRef(puzzle, state.puzzle)) {
            if (!confirm('you have unsaved changes in the editor. discard them?')) return false;
        }

        update({ puzzle, dirty: false, pendingCode: null, detail: null, detailError: null, lastRun: null, lastSubmit: null, lastError: null });
        settings.set({ lastPuzzle: puzzle, lastBySource: { ...settings.get().lastBySource, [puzzle.source]: puzzle } });
        await this.refreshDetail();
        return true;
    },

    async refreshDetail(): Promise<void> {
        const target = state.puzzle;
        if (!target) return;
        try {
            const detail = await api.detail(target);
            if (sameRef(target, state.puzzle)) update({ detail, detailError: null });
        } catch (error) {
            if (sameRef(target, state.puzzle)) update({ detailError: errorMessage(error) });
        }
    },

    /** the code panel reports edits here so run/submit can save first */
    setPendingCode(code: string | null): void {
        update({ pendingCode: code, dirty: code !== null });
    },

    async saveSolution(): Promise<void> {
        if (state.pendingCode === null || !state.puzzle) return;
        await api.saveSolution(state.puzzle, state.pendingCode);
        update({ pendingCode: null, dirty: false });
    },

    /** scaffolds the puzzle; resolves with the input warning (if any) so panels can show it */
    async fetchPuzzle(inputOnly = false): Promise<string | null> {
        const target = state.puzzle;
        if (!target) return null;
        update({ lastError: null });
        try {
            const result = await api.fetch(target, inputOnly);
            if (result.inputError) update({ lastError: result.inputError });
            return result.inputError;
        } catch (error) {
            update({ lastError: errorMessage(error) });
            throw error;
        } finally {
            await this.refreshDetail();
            await this.loadGroups(target.source);
        }
    },

    async run(
        options: { part: Part; iterations?: number; updateReadme?: boolean; debug?: boolean; commit?: boolean },
        signal?: AbortSignal,
        handlers: RunHandlers = {},
    ): Promise<RunOutcome | null> {
        const target = state.puzzle;
        if (state.running || !target) return null;
        update({ running: true, lastError: null, lastSubmit: null });
        try {
            await this.saveSolution();
            const outcome = await api.runStream(target, { ...options, timeoutMs: settings.get().runTimeoutMs }, handlers, signal);
            update({ lastRun: outcome });
            return outcome;
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) update({ lastError: errorMessage(error) });
            return null;
        } finally {
            update({ running: false });
            await this.refreshDetail();
        }
    },

    /** runs against an example input; not recorded and does not replace the runner panel's last result */
    async runExample(options: { part: Part; input: string; debug?: boolean }, signal?: AbortSignal, handlers: RunHandlers = {}): Promise<RunOutcome | null> {
        const target = state.puzzle;
        if (state.running || !target) return null;
        update({ running: true, lastError: null });
        try {
            await this.saveSolution();
            return await api.runStream(
                target,
                { part: options.part, iterations: 1, input: options.input, debug: options.debug, timeoutMs: settings.get().runTimeoutMs },
                handlers,
                signal,
            );
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) update({ lastError: errorMessage(error) });
            return null;
        } finally {
            update({ running: false });
        }
    },

    async submit(options: { part: Part; record: boolean }): Promise<SubmitOutcome | null> {
        const target = state.puzzle;
        if (state.running || !target) return null;
        update({ running: true, lastError: null, lastSubmit: null });
        try {
            await this.saveSolution();
            const outcome = await api.submit(target, options);
            update({ lastSubmit: outcome });
            return outcome;
        } catch (error) {
            update({ lastError: errorMessage(error) });
            return null;
        } finally {
            update({ running: false });
            await this.refreshDetail();
            await this.loadGroups(target.source);
        }
    },

    clearError(): void {
        update({ lastError: null });
    },
};
