/**
 * frontend/src/panels/code.ts
 *
 * monaco editor bound to the active puzzle's solution file
 */

import type * as Monaco from 'monaco-editor';
import { api } from '../api.ts';
import { debugStore } from '../debugstore.ts';
import { h, replace } from '../dom.ts';
import { editorOptions, loadMonaco } from '../editor.ts';
import { settings } from '../settings.ts';
import { monacoThemeName, onThemeChange } from '../themes.ts';
import { actions, activeSource, getState, refKey, sameRef, subscribe } from '../state.ts';
import type { PanelDefinition } from '../workspace.ts';

/** monaco language ids for the solution file extensions people are likely to use */
const LANGUAGES: Record<string, string> = {
    ts: 'typescript',
    js: 'javascript',
    mjs: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    java: 'java',
    kt: 'kotlin',
    rb: 'ruby',
    php: 'php',
    lua: 'lua',
    swift: 'swift',
    sh: 'shell',
    sql: 'sql',
    fs: 'fsharp',
    scala: 'scala',
    pl: 'perl',
    r: 'r',
    jl: 'julia',
    dart: 'dart',
    ex: 'elixir',
    clj: 'clojure',
    hs: 'plaintext',
    zig: 'plaintext',
    nim: 'plaintext',
};

export const codePanel: PanelDefinition = {
    id: 'code',
    title: 'Code',
    create(container) {
        let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
        let monaco: Monaco.editor.IStandaloneCodeEditor extends never ? never : typeof Monaco | null = null;
        let savedCode: string | null = null;
        let loadedFor = '';
        let disposed = false;
        let zoom = 1;
        let decorations: Monaco.editor.IEditorDecorationsCollection | null = null;

        const options = () => {
            const base = editorOptions(settings.get());
            return { ...base, fontSize: Math.round((base.fontSize ?? 14) * zoom * 10) / 10 };
        };

        const path = h('span', { className: 'dim path' });
        const status = h('span', { className: 'dim' });
        const saveButton = h('button', { className: 'link', onClick: () => save() }, 'save');
        const host = h('div', { className: 'fill' });
        const overlay = h('div', { className: 'empty' });
        const body = h('div', { className: 'body tight', style: 'display: flex; flex-direction: column' });

        container.append(
            h('div', { className: 'panel' }, h('div', { className: 'toolbar' }, saveButton, path, h('span', { className: 'spacer' }), status), body),
        );

        const setStatus = (text: string, className = 'dim') => {
            status.textContent = text;
            status.className = className;
        };

        const save = async () => {
            if (!editor || savedCode === null) return;
            const code = editor.getValue();
            const target = getState().puzzle;
            if (!target) return;
            try {
                await api.saveSolution(target, code);
                savedCode = code;
                actions.setPendingCode(null);
                setStatus('saved', 'ok');
            } catch (error) {
                setStatus(error instanceof Error ? error.message : String(error), 'error');
            }
        };

        const showOverlay = (...children: Parameters<typeof replace>[1][]) => {
            replace(overlay, ...children);
            replace(body, overlay);
        };

        const showEditor = () => {
            if (body.firstChild !== host) replace(body, host);
        };

        const load = async () => {
            const { puzzle } = getState();
            const source = activeSource();
            if (!puzzle || !source) return;
            const key = refKey(puzzle);
            if (key === loadedFor) return;
            loadedFor = key;
            path.textContent = '';
            savedCode = null;
            setStatus('loading…');
            showOverlay('loading…');

            try {
                const [solution, monacoApi] = await Promise.all([api.solution(puzzle), loadMonaco()]);
                if (disposed || loadedFor !== key) return;
                monaco = monacoApi;
                const code = solution?.code ?? null;
                const file = solution?.file ?? source.solutionFile;
                renderPath(file);

                if (code === null) {
                    setStatus('no solution yet');
                    showOverlay(
                        h('p', null, 'this puzzle has not been generated yet.'),
                        h('button', {
                            className: 'link',
                            onClick: async (event: Event) => {
                                (event.target as HTMLButtonElement).disabled = true;
                                try {
                                    const warning = await actions.fetchPuzzle();
                                    loadedFor = '';
                                    await load();
                                    if (warning) setStatus(`solution created, but ${warning}`, 'error');
                                } catch (error) {
                                    setStatus(error instanceof Error ? error.message : String(error), 'error');
                                    (event.target as HTMLButtonElement).disabled = false;
                                }
                            },
                        }, source.capabilities.fetchInputs ? `fetch puzzle: create ${file} and download the input` : `create ${file}`),
                    );
                    return;
                }

                showEditor();
                if (!editor) {
                    editor = monaco.editor.create(host, { ...options(), theme: monacoThemeName(), language: 'typescript', value: '' });
                    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
                    decorations = editor.createDecorationsCollection();
                    // clicking the glyph margin toggles a breakpoint for the debugger panel
                    editor.onMouseDown((event) => {
                        const position = event.target.position;
                        if (monaco && position && event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
                            const target = getState().puzzle;
                            if (target) debugStore.toggleBreakpoint(target, position.lineNumber);
                        }
                    });
                    editor.onDidChangeModelContent(() => {
                        if (savedCode === null) return;
                        const dirty = editor!.getValue() !== savedCode;
                        actions.setPendingCode(dirty ? editor!.getValue() : null);
                        setStatus(dirty ? 'unsaved changes' : 'saved', dirty ? '' : 'ok');
                    });
                }

                savedCode = null; // suppress dirty tracking while swapping content
                const model = editor.getModel();
                if (model) monaco.editor.setModelLanguage(model, LANGUAGES[file.split('.').pop() ?? ''] ?? 'plaintext');
                editor.setValue(code);
                savedCode = code;
                actions.setPendingCode(null);
                setStatus('saved', 'ok');
                editor.focus();
                renderDecorations();
            } catch (error) {
                if (loadedFor !== key) return;
                loadedFor = ''; // allow the next puzzle change (or token fix) to retry
                setStatus(error instanceof Error ? error.message : String(error), 'error');
                showOverlay(h('span', { className: 'error' }, error instanceof Error ? error.message : String(error)));
            }
        };

        /** breakpoint dots and the line the debugger is paused on */
        const renderDecorations = () => {
            if (!editor || !monaco || !decorations) return;
            const puzzle = getState().puzzle;
            if (!puzzle) return;
            const items: Monaco.editor.IModelDeltaDecoration[] = debugStore.breakpoints(puzzle).map((line) => ({
                range: new monaco!.Range(line, 1, line, 1),
                options: { glyphMarginClassName: 'bp-glyph', glyphMarginHoverMessage: { value: `breakpoint at line ${line}` } },
            }));
            const paused = debugStore.paused;
            if (paused && sameRef(paused, puzzle) && paused.line > 0) {
                items.push({
                    range: new monaco!.Range(paused.line, 1, paused.line, 1),
                    options: { isWholeLine: true, className: 'debug-current-line', glyphMarginClassName: 'debug-current-glyph' },
                });
                editor.revealLineInCenterIfOutsideViewport(paused.line);
            }
            decorations.set(items);
        };

        /** the file's place in its repository, once the detail has told us */
        let shownFile = '';
        const renderPath = (file = shownFile) => {
            shownFile = file;
            const { detail } = getState();
            path.textContent = file ? `${detail ? `${detail.path}/` : ''}${file}` : '';
        };

        const unsubscribes = [
            subscribe(load, ['puzzle', 'hub']),
            subscribe(() => renderPath(), ['detail']),
            onThemeChange((id, mode) => monaco?.editor.setTheme(monacoThemeName(id, mode))),
            debugStore.onChange(renderDecorations),
            // when a run auto-saved the pending code, reflect that here
            subscribe(() => {
                const { dirty, pendingCode } = getState();
                if (!dirty && editor && savedCode !== null && pendingCode === null && editor.getValue() !== savedCode) {
                    savedCode = editor.getValue();
                    setStatus('saved', 'ok');
                }
            }, ['dirty']),
            settings.onChange(() => editor?.updateOptions(options())),
        ];

        load();

        return {
            setZoom: (factor) => {
                zoom = factor;
                editor?.updateOptions(options());
            },
            dispose: () => {
                disposed = true;
                unsubscribes.forEach((fn) => fn());
                editor?.dispose();
            },
        };
    },
};
