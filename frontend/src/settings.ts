/**
 * frontend/src/settings.ts
 *
 * user preferences persisted in localStorage
 */

import type { ModeSetting } from './themes.ts';
import type { Part, PuzzleRef } from './types.ts';

export interface Settings {
    token: string;
    apiBase: string;
    defaultPart: Part;
    defaultIterations: number;
    defaultRecord: boolean;
    confirmSubmit: boolean;
    profilePush: boolean;
    runTimeoutMs: number;
    editorFontSize: number;
    editorMinimap: boolean;
    editorWordWrap: boolean;
    editorTabSize: number;
    snowflakes: boolean;
    theme: string;
    /** light, dark, or whatever the operating system is set to */
    themeMode: ModeSetting;
    /** switch to a site's own theme while one of its puzzles is on screen */
    themeFollowsSource: boolean;
    puzzlePanelMode: 'text' | 'website';
    lastPuzzle: PuzzleRef | null;
    /** where you last were in each source, so switching platform takes you back there */
    lastBySource: Record<string, PuzzleRef>;
    dashboardSource: string | null;
}

const STORAGE_KEY = 'hub.settings';

export const DEFAULT_SETTINGS: Settings = {
    token: '',
    apiBase: '',
    defaultPart: 'all',
    defaultIterations: 10,
    defaultRecord: false,
    confirmSubmit: true,
    profilePush: true,
    runTimeoutMs: 120_000,
    editorFontSize: 14,
    editorMinimap: false,
    editorWordWrap: false,
    editorTabSize: 4,
    snowflakes: true,
    theme: 'aoc',
    themeMode: 'auto',
    themeFollowsSource: true,
    puzzlePanelMode: 'text',
    lastPuzzle: null,
    lastBySource: {},
    dashboardSource: null,
};

type Listener = (settings: Settings, changed: (keyof Settings)[]) => void;

const load = (): Settings => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        const stored = JSON.parse(raw);
        // "light" used to be a theme of its own; it is now the light mode of the advent of code theme
        if (stored.theme === 'light') Object.assign(stored, { theme: 'aoc', themeMode: 'light' });
        return { ...DEFAULT_SETTINGS, ...stored };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
};

let current = load();
const listeners = new Set<Listener>();

export const settings = {
    get: (): Settings => current,

    set(patch: Partial<Settings>): void {
        const changed = (Object.keys(patch) as (keyof Settings)[]).filter((key) => JSON.stringify(patch[key]) !== JSON.stringify(current[key]));
        if (changed.length === 0) return;
        current = { ...current, ...patch };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
        for (const listener of listeners) listener(current, changed);
    },

    reset(): void {
        this.set({ ...DEFAULT_SETTINGS, token: current.token, apiBase: current.apiBase });
    },

    onChange(listener: Listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};
