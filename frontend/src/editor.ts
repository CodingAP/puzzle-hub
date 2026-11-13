/**
 * frontend/src/editor.ts
 *
 * loads monaco through the amd loader included in index.html and configures it for typescript solutions
 */

import type * as Monaco from 'monaco-editor';
import type { Settings } from './settings.ts';
import { monacoThemeName, THEMES } from './themes.ts';

declare const require: (modules: string[], callback: () => void) => void;

declare global {
    var monaco: typeof Monaco;
}

export type MonacoApi = typeof Monaco;

let loading: Promise<MonacoApi> | null = null;

const configure = (monaco: MonacoApi) => {
    const ts = monaco.typescript; // moved out of monaco.languages in 0.55
    ts.typescriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        allowNonTsExtensions: true,
        strict: true,
        noEmit: true,
        lib: ['esnext', 'dom', 'dom.iterable'], // deno exposes console, performance, crypto, TextEncoder… like the browser does
    });
    // bare specifiers (@std/crypto) and relative deno imports (../intcode.ts) cannot be resolved in the browser
    ts.typescriptDefaults.setDiagnosticsOptions({ diagnosticCodesToIgnore: [2307, 2792, 5097] });

    for (const theme of THEMES) {
        for (const mode of ['light', 'dark'] as const) {
            monaco.editor.defineTheme(monacoThemeName(theme.id, mode), {
                base: mode === 'dark' ? 'vs-dark' : 'vs',
                inherit: true,
                rules: theme.editor[mode].rules ?? [],
                colors: theme.editor[mode].colors,
            });
        }
    }
};

/**
 * resolves the monaco namespace once it is available
 */
export const loadMonaco = (): Promise<MonacoApi> => {
    loading ??= new Promise<MonacoApi>((resolve, reject) => {
        if (typeof require !== 'function') return reject(new Error('monaco loader missing'));
        require(['vs/editor/editor.main'], () => {
            configure(globalThis.monaco);
            resolve(globalThis.monaco);
        });
    });
    return loading;
};

export const editorOptions = (settings: Settings): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions => ({
    fontSize: settings.editorFontSize,
    fontFamily: "'Source Code Pro', monospace",
    minimap: { enabled: settings.editorMinimap },
    wordWrap: settings.editorWordWrap ? 'on' : 'off',
    tabSize: settings.editorTabSize,
    insertSpaces: true,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    glyphMargin: true, // breakpoints live here
    renderWhitespace: 'selection',
    smoothScrolling: true,
});
