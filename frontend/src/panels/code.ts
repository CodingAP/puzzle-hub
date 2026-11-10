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
        let monaco: typeof Monaco | null = null;
        let savedCode: string | null = null;
        let loadedFor = '';
        let disposed = false;
        let zoom = 1;
        let decorations: Monaco.editor.IEditorDecorationsCollection | null = null;
        /** the text a run or submit took along to save first; until that is accounted for the file may hold it instead of savedCode */
        let sent: string | null = null;

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
                if (loadedFor !== refKey(target)) return; // another puzzle was opened meanwhile: the editor is no longer this file
                savedCode = code;
                sent = null;
                // text typed while the save was under way was not sent: it stays pending
                const latest = editor.getValue();
                actions.setPendingCode(latest === code ? null : latest);
                setStatus(latest === code ? 'saved' : 'unsaved changes', latest === code ? 'ok' : '');
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
            sent = null;
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
                    // monaco only binds ctrl+y to redo on windows; bind it everywhere
                    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => editor?.trigger('keyboard', 'redo', null));
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
                        // while an auto-save is unaccounted for, the file may not be savedCode any more: any text counts as unsaved
                        const dirty = sent !== null || editor!.getValue() !== savedCode;
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
            // a run or submit saves the pending code first: note what it takes along
            subscribe(() => {
                const { running, pendingCode } = getState();
                if (running) sent = pendingCode;
            }, ['running']),
            // the pending code was cleared somewhere else while the editor may still differ from the file
            subscribe(() => {
                const { dirty, pendingCode, puzzle, running } = getState();
                if (dirty || pendingCode !== null || !editor || savedCode === null || loadedFor !== refKey(puzzle)) return;
                const code = editor.getValue();
                if (code === savedCode && sent === null) return;
                if (running && code === sent) {
                    // the auto-save wrote exactly this text (it only clears what it sent): reflect that here
                    savedCode = code;
                    sent = null;
                    setStatus('saved', 'ok');
                } else {
                    // nothing wrote it (the same puzzle was reloaded, say): the text is still unsaved
                    actions.setPendingCode(code);
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
