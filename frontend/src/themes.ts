/**
 * frontend/src/themes.ts
 *
 * colour themes. every theme comes in a light and a dark mode: the css variables for both live in styles.css
 * ([data-theme=...] and [data-theme=...][data-mode=...]); this file lists the themes and carries the matching
 * monaco editor colours.
 */

export type Mode = 'light' | 'dark';
/** what the user picks: a fixed mode, or whatever the operating system is set to */
export type ModeSetting = Mode | 'auto';

interface EditorColors {
    colors: Record<string, string>;
    rules?: { token: string; foreground?: string; fontStyle?: string }[];
}

export interface Theme {
    id: string;
    name: string;
    editor: Record<Mode, EditorColors>;
}

const rules = (keyword: string, string: string, number: string, comment: string, type?: string) => [
    { token: 'keyword', foreground: keyword },
    { token: 'string', foreground: string },
    { token: 'number', foreground: number },
    { token: 'comment', foreground: comment, fontStyle: 'italic' },
    ...(type ? [{ token: 'type', foreground: type }] : []),
];

const colors = (background: string, foreground: string, lineNumber: string, accent: string, lineHighlight: string, selection: string) => ({
    'editor.background': background,
    'editor.foreground': foreground,
    'editorLineNumber.foreground': lineNumber,
    'editorLineNumber.activeForeground': accent,
    'editorCursor.foreground': accent,
    'editor.lineHighlightBorder': lineHighlight,
    'editor.selectionBackground': selection,
});

export const THEMES: Theme[] = [
    {
        id: 'aoc',
        name: 'advent of code',
        editor: {
            dark: {
                colors: {
                    'editor.background': '#0f0f23',
                    'editorLineNumber.foreground': '#666688',
                    'editorLineNumber.activeForeground': '#00cc00',
                    'editorCursor.foreground': '#00cc00',
                    'editor.lineHighlightBorder': '#1f1f3a',
                },
            },
            light: {
                colors: {
                    'editor.background': '#ffffff',
                    'editorLineNumber.foreground': '#9aa0b0',
                    'editorLineNumber.activeForeground': '#0a7a0a',
                    'editorCursor.foreground': '#0a7a0a',
                    'editor.lineHighlightBorder': '#e6e9f0',
                },
            },
        },
    },
    {
        id: 'ec',
        name: 'everybody codes',
        editor: {
            dark: {
                colors: colors('#01070a', '#d6d2c4', '#3f4d52', '#eed699', '#0b1c22', '#12343a'),
                rules: rules('00db43', 'eed699', 'fb923c', '68726f', '6ee7b7'),
            },
            light: {
                colors: colors('#ffffff', '#1e1e1e', '#a9b0ad', '#087a37', '#f1efe6', '#d7efdf'),
                rules: rules('087a37', '9a6b00', 'c2410c', '68726f', '0f766e'),
            },
        },
    },
    {
        id: 'aquaq',
        name: 'aquaq',
        editor: {
            dark: {
                colors: colors('#212529', '#dee2e6', '#6c757d', '#6ea8fe', '#2b3035', '#3a4a5f'),
                rules: rules('6ea8fe', '75b798', 'e685b5', '6c757d', 'a98eda'),
            },
            light: {
                colors: colors('#ffffff', '#212529', '#adb5bd', '#007bff', '#e9ecef', '#cfe2ff'),
                rules: rules('0056b3', '1e7e34', 'd63384', '6c757d', '6610f2'),
            },
        },
    },
    {
        id: 'hacker',
        name: 'hacker',
        editor: {
            dark: {
                colors: colors('#000000', '#33ff33', '#1f8f1f', '#00ff41', '#0f3f0f', '#0f5f0f'),
                rules: [
                    { token: '', foreground: '33ff33' },
                    { token: 'comment', foreground: '1f8f1f', fontStyle: 'italic' },
                    { token: 'keyword', foreground: '00ff41', fontStyle: 'bold' },
                    { token: 'string', foreground: 'aaffaa' },
                    { token: 'number', foreground: 'ffff33' },
                    { token: 'type', foreground: '66ff99' },
                    { token: 'identifier', foreground: '33ff33' },
                ],
            },
            light: {
                colors: colors('#eef6ea', '#0b3d0b', '#7fae7f', '#0a6b1e', '#dcebd6', '#bfe3bf'),
                rules: [
                    { token: '', foreground: '0b3d0b' },
                    { token: 'comment', foreground: '6f9a6f', fontStyle: 'italic' },
                    { token: 'keyword', foreground: '0a6b1e', fontStyle: 'bold' },
                    { token: 'string', foreground: '2f7d32' },
                    { token: 'number', foreground: '8a6d00' },
                    { token: 'type', foreground: '1b7a4a' },
                    { token: 'identifier', foreground: '0b3d0b' },
                ],
            },
        },
    },
    {
        id: 'aero',
        name: 'frutiger aero',
        editor: {
            dark: { colors: colors('#0b1a2e99', '#dceeff', '#4f7396', '#6cc0ff', '#16304f', '#1f4d7a'), rules: rules('6cc0ff', '7fe0a0', 'ffc266', '6f8fb0') },
            light: { colors: colors('#ffffff88', '#1a2a3a', '#8fb3d9', '#0b74d1', '#dcecfb', '#bfe0ff'), rules: rules('0b74d1', '2e8b2e', 'd17b0b', '7a97b3') },
        },
    },
    {
        id: 'dracula',
        name: 'dracula',
        editor: {
            dark: {
                colors: colors('#282a36', '#f8f8f2', '#6272a4', '#f8f8f2', '#44475a', '#44475a'),
                rules: rules('ff79c6', 'f1fa8c', 'bd93f9', '6272a4', '8be9fd'),
            },
            light: {
                colors: colors('#fffbeb', '#1f1f1f', '#6c664b', '#1f1f1f', '#efe9d5', '#cfcfde'),
                rules: rules('a3144d', '846e15', '644ac9', '6c664b', '036a96'),
            },
        },
    },
    {
        id: 'nord',
        name: 'nord',
        editor: {
            dark: {
                colors: colors('#2e3440', '#d8dee9', '#4c566a', '#d8dee9', '#3b4252', '#434c5e'),
                rules: rules('81a1c1', 'a3be8c', 'b48ead', '616e88', '8fbcbb'),
            },
            light: {
                colors: colors('#eceff4', '#2e3440', '#a3adbf', '#2e3440', '#e5e9f0', '#d8dee9'),
                rules: rules('5e81ac', '5f8a45', '8f6593', '8a94a8', '4f8f8d'),
            },
        },
    },
    {
        id: 'synthwave',
        name: 'synthwave',
        editor: {
            dark: {
                colors: colors('#241b2f', '#e0d6ff', '#7a6b8f', '#ff7edb', '#3a2d4d', '#4a3b63'),
                rules: rules('ff7edb', 'fede5d', 'f97e72', '7a6b8f', '36f9f6'),
            },
            light: {
                colors: colors('#fdf4ff', '#3b2a55', '#b9a3d0', '#d6249f', '#f6e6fb', '#f0cdf5'),
                rules: rules('d6249f', 'b07a00', 'e0553f', 'a08bb8', '0e9aa0'),
            },
        },
    },
];

export const DEFAULT_THEME = 'aoc';

export const getTheme = (id: string): Theme => THEMES.find((theme) => theme.id === id) ?? THEMES[0];

/** the theme each puzzle site looks like, used when "match the theme to the site" is on */
export const SOURCE_THEMES: Record<string, string> = {
    'advent-of-code': 'aoc',
    'everybody-codes': 'ec',
    aquaq: 'aquaq',
};

const systemDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)');

/** light or dark for a setting; automatic follows the operating system */
export const resolveMode = (setting: ModeSetting): Mode => (setting === 'auto' ? (systemDark?.matches === false ? 'light' : 'dark') : setting);

/** calls back when the operating system switches between light and dark */
export const onSystemModeChange = (listener: () => void): void => systemDark?.addEventListener('change', listener);

let active = DEFAULT_THEME;
let activeModeValue: Mode = 'dark';
const listeners = new Set<(id: string, mode: Mode) => void>();

/** the theme currently on screen (the chosen one, or the site's own while one of its puzzles is shown) */
export const activeThemeId = () => active;
export const activeMode = () => activeModeValue;

export const monacoThemeName = (id: string = active, mode: Mode = activeModeValue) => `hub-${getTheme(id).id}-${mode}`;

export const onThemeChange = (listener: (id: string, mode: Mode) => void): () => void => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/**
 * switches the css variables (and the dock's base theme class) for the whole app
 */
export const applyTheme = (id: string, mode: Mode): Theme => {
    const theme = getTheme(id);
    const root = document.documentElement;
    root.dataset.theme = theme.id;
    root.dataset.mode = mode;
    root.classList.toggle('theme-dark', mode === 'dark');
    root.classList.toggle('theme-light', mode === 'light');
    root.style.colorScheme = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.editor[mode].colors['editor.background'].slice(0, 7));
    if (theme.id !== active || mode !== activeModeValue) {
        active = theme.id;
        activeModeValue = mode;
        for (const listener of listeners) listener(active, mode);
    }
    return theme;
};
