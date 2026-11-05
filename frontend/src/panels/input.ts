/**
 * frontend/src/panels/input.ts
 *
 * the puzzle input: one per puzzle, or one per part on sites that work that way. it can be downloaded again, or
 * pasted in by hand for sites the hub cannot download from.
 */

import { api } from '../api.ts';
import { clear, h, replace } from '../dom.ts';
import { actions, activeSource, getState, refKey, subscribe } from '../state.ts';
import type { PanelDefinition } from '../workspace.ts';

export const inputPanel: PanelDefinition = {
    id: 'input',
    title: 'Input',
    create(container) {
        const info = h('span', { className: 'dim' });
        const body = h('div', { className: 'body' });
        const partTabs = h('span', { className: 'group' });
        const editor = h('textarea', { className: 'fill', spellcheck: false, placeholder: 'paste the puzzle input here' });
        let text = '';
        let loadedFor = '';
        let part = 1;
        let editing = false;

        const copy = h('button', { className: 'link', onClick: () => navigator.clipboard.writeText(text) }, 'copy');
        const refresh = h('button', {
            className: 'link',
            title: 'download the input again',
            onClick: async () => {
                try {
                    await actions.fetchPuzzle(true);
                    loadedFor = '';
                    await load();
                } catch {
                    // error is shown in the top bar
                }
            },
        }, 're-download');
        const editButton = h('button', { className: 'link', title: 'paste or change the input by hand', onClick: () => setEditing(!editing) }, 'edit');
        const saveButton = h('button', { className: 'link', style: 'display: none', onClick: () => save() }, 'save');

        container.append(
            h(
                'div',
                { className: 'panel' },
                h('div', { className: 'toolbar' }, partTabs, copy, refresh, editButton, saveButton, h('span', { className: 'spacer' }), info),
                body,
            ),
        );

        const setEditing = (next: boolean) => {
            editing = next;
            editButton.textContent = next ? 'cancel' : 'edit';
            saveButton.style.display = next ? '' : 'none';
            if (next) {
                editor.value = text;
                replace(body, editor);
                body.classList.add('tight');
                editor.focus();
            } else {
                body.classList.remove('tight');
                show();
            }
        };

        const save = async () => {
            const target = getState().puzzle;
            if (!target) return;
            try {
                await api.saveInput(target, part, editor.value);
                text = editor.value;
                setEditing(false);
                await actions.refreshDetail();
            } catch (error) {
                info.textContent = error instanceof Error ? error.message : String(error);
                info.className = 'error';
            }
        };

        const renderTabs = () => {
            const source = activeSource();
            clear(partTabs);
            refresh.style.display = source?.capabilities.fetchInputs ? '' : 'none';
            if (!source?.perPartInput) return;
            const have = getState().detail?.inputs ?? [];
            for (let number = 1; number <= source.parts; number++) {
                partTabs.append(h('button', {
                    className: `link${number === part ? ' current' : ''}`,
                    title: have[number - 1] === false ? 'not on disk yet' : '',
                    onClick: () => {
                        part = number;
                        loadedFor = '';
                        renderTabs();
                        load();
                    },
                }, `part ${number}${have[number - 1] === false ? ' ·' : ''}`));
            }
        };

        const show = () => {
            info.className = 'dim';
            if (text === '') {
                const source = activeSource();
                info.textContent = '';
                return replace(
                    body,
                    h(
                        'div',
                        { className: 'empty' },
                        source?.capabilities.fetchInputs
                            ? 'no input on disk for this puzzle: fetch it from the code panel, press re-download, or paste it with edit.'
                            : `${source?.provider.name ?? 'this site'}'s inputs cannot be downloaded: press edit and paste yours.`,
                    ),
                );
            }
            const lines = text.replace(/\n$/, '').split('\n').length;
            info.textContent = `${lines} line${lines === 1 ? '' : 's'} · ${text.length} chars`;
            replace(body, h('pre', null, text));
        };

        const load = async () => {
            const target = getState().puzzle;
            const source = activeSource();
            if (!target) return;
            if (!source?.perPartInput || part > source.parts) part = 1;
            const key = `${refKey(target)}#${part}`;
            if (key === loadedFor) return;
            loadedFor = key;
            if (editing) setEditing(false);
            renderTabs();
            replace(body, h('div', { className: 'empty' }, 'loading…'));
            info.textContent = '';
            try {
                const input = await api.input(target, part);
                if (loadedFor !== key) return;
                text = input ?? '';
                show();
            } catch (error) {
                loadedFor = '';
                replace(body, h('div', { className: 'empty error' }, error instanceof Error ? error.message : String(error)));
            }
        };

        const unsubscribes = [
            subscribe(load, ['puzzle', 'hub']),
            subscribe(() => {
                renderTabs();
                // a fetch may have produced the input after the first load
                const { detail } = getState();
                if (detail?.inputs[part - 1] && text === '' && !editing) {
                    loadedFor = '';
                    load();
                }
            }, ['detail']),
        ];
        load();

        return { dispose: () => unsubscribes.forEach((fn) => fn()) };
    },
};
