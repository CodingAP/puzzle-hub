/**
 * frontend/src/panels/tests.ts
 *
 * run the solution against example inputs: saved ones (with expected answers) or code blocks lifted from the puzzle text
 */

import { api } from '../api.ts';
import { clear, formatMs, h, replace } from '../dom.ts';
import { debugStore } from '../debugstore.ts';
import { createLiveLog } from '../livelog.ts';
import { plainCode } from '../markdown.ts';
import { settings } from '../settings.ts';
import { actions, activeSource, getState, partKeys, partName, refKey, subscribe } from '../state.ts';
import { partSelect } from './runner.ts';
import type { Example, Part, RunOutcome } from '../types.ts';
import type { PanelDefinition } from '../workspace.ts';

type Selection = { kind: 'saved'; index: number } | { kind: 'suggested'; index: number } | { kind: 'new' };

/** fenced code blocks in the puzzle text are almost always the examples */
const suggestionsFrom = (markdown: string): Example[] => {
    const seen = new Set<string>();
    const examples: Example[] = [];
    for (const match of markdown.matchAll(/```\n([\s\S]*?)\n```/g)) {
        const input = plainCode(match[1]);
        if (!input.trim() || seen.has(input)) continue;
        seen.add(input);
        examples.push({ name: `puzzle text #${examples.length + 1}`, input: input + '\n' });
    }
    return examples;
};

const encode = (selection: Selection) => (selection.kind === 'new' ? 'new' : `${selection.kind}:${selection.index}`);
const decode = (value: string): Selection => {
    const [kind, index] = value.split(':');
    if (kind === 'saved' || kind === 'suggested') return { kind, index: Number(index) };
    return { kind: 'new' };
};

export const testsPanel: PanelDefinition = {
    id: 'tests',
    title: 'Tests',
    create(container, { workspace }) {
        let saved: Example[] = [];
        let suggested: Example[] = [];
        let selection: Selection = { kind: 'new' };
        let loadedFor = '';

        const picker = h('select', { title: 'example to run' }) as HTMLSelectElement;
        const name = h('input', { type: 'text', placeholder: 'name', title: 'example name' });
        /** one expected-answer box per part of the active source */
        const expectedBox = h('span', { className: 'tests-expected' });
        let expectedInputs: Record<string, HTMLInputElement> = {};
        const renderExpected = () => {
            const keys = partKeys(activeSource());
            if (keys.join() === Object.keys(expectedInputs).join()) return;
            const previous = expectedInputs;
            expectedInputs = {};
            const children: (HTMLElement | string)[] = [];
            keys.forEach((key, index) => {
                const box = h('input', {
                    type: 'text',
                    placeholder: keys.length > 1 ? partName(key) : 'answer',
                    title: `expected answer${keys.length > 1 ? ` for ${partName(key)}` : ''}`,
                });
                box.value = previous[key]?.value ?? '';
                expectedInputs[key] = box;
                if (index > 0) children.push(' / ');
                children.push(box);
            });
            replace(expectedBox, children);
        };
        const input = h('textarea', { className: 'tests-input', spellcheck: false, rows: 6, placeholder: 'paste an example input here' });
        const part = partSelect(settings.get().defaultPart);
        const result = h('div', { className: 'tests-result' });
        const live = createLiveLog();
        let controller: AbortController | null = null;
        const status = h('span', { className: 'dim' });
        const lineInfo = h('span', { className: 'dim' });

        const runButton = h('button', { className: 'link', onClick: () => run() }, '▶ run');
        const debugButton = h('button', {
            className: 'link',
            title: 'open the debugger panel and run this example under it',
            onClick: () => {
                const example = current();
                if (!example.input.trim()) return setStatus('nothing to debug: the input is empty', 'error');
                workspace.open('debugger');
                debugStore.requestSession({ part: part.value as Part, input: example.input, label: example.name });
            },
        }, '🐞 debug');
        const cancelButton = h('button', { className: 'link error', style: 'display: none', onClick: () => controller?.abort() }, 'cancel');
        const saveButton = h(
            'button',
            { className: 'link', title: 'store this example (and expected answers) in examples.json', onClick: () => save() },
            'save',
        );
        const deleteButton = h('button', { className: 'link', onClick: () => remove() }, 'delete');
        const newButton = h('button', { className: 'link', onClick: () => select({ kind: 'new' }) }, '+ new');

        const setStatus = (text: string, className = 'dim') => {
            status.textContent = text;
            status.className = className;
        };

        const updateLineInfo = () => {
            const lines = input.value.replace(/\n$/, '').split('\n').length;
            lineInfo.textContent = input.value ? `${lines} line${lines === 1 ? '' : 's'} · ${input.value.length} chars` : '';
        };
        input.addEventListener('input', updateLineInfo);

        const current = (): Example => ({
            name: name.value.trim() || 'example',
            input: input.value,
            expected: Object.fromEntries(Object.entries(expectedInputs).map(([key, box]) => [key, box.value.trim()]).filter(([, value]) => value)),
        });

        const fill = (example: Example | null) => {
            name.value = example?.name ?? `example ${saved.length + 1}`;
            input.value = example?.input ?? '';
            for (const [key, box] of Object.entries(expectedInputs)) box.value = example?.expected?.[key] ?? '';
            updateLineInfo();
            clear(result);
        };

        const renderPicker = () => {
            clear(picker);
            const group = (label: string, examples: Example[], kind: 'saved' | 'suggested') => {
                if (!examples.length) return;
                const optgroup = h('optgroup', { label });
                examples.forEach((example, index) => {
                    const keys = partKeys(activeSource());
                    const hint = kind === 'saved' && keys.some((key) => example.expected?.[key])
                        ? ` → ${keys.map((key) => example.expected?.[key] ?? '?').join(' / ')}`
                        : '';
                    optgroup.append(h('option', { value: `${kind}:${index}` }, `${example.name}${hint}`));
                });
                picker.append(optgroup);
            };
            group('saved', saved, 'saved');
            group('from puzzle text', suggested, 'suggested');
            picker.append(h('option', { value: 'new' }, saved.length || suggested.length ? 'new example…' : 'new example (no suggestions yet)'));
            picker.value = encode(selection);
        };

        const select = (next: Selection) => {
            selection = next;
            if (next.kind === 'saved') fill(saved[next.index] ?? null);
            else if (next.kind === 'suggested') fill(suggested[next.index] ?? null);
            else fill(null);
            deleteButton.disabled = next.kind !== 'saved';
            renderPicker();
            setStatus('');
        };

        picker.addEventListener('change', () => select(decode(picker.value)));

        const persist = async (next: Example[]) => {
            const target = getState().puzzle;
            if (target) saved = await api.saveExamples(target, next);
        };

        const save = async () => {
            try {
                const example = current();
                const next = [...saved];
                let index: number;
                if (selection.kind === 'saved') {
                    index = selection.index;
                    next[index] = example;
                } else {
                    index = next.length;
                    next.push(example);
                }
                await persist(next);
                select({ kind: 'saved', index: Math.min(index, saved.length - 1) });
                setStatus('saved to examples.json', 'ok');
            } catch (error) {
                setStatus(error instanceof Error ? error.message : String(error), 'error');
            }
        };

        const remove = async () => {
            if (selection.kind !== 'saved') return;
            const index = selection.index;
            if (!confirm(`delete example '${saved[index]?.name}'?`)) return;
            try {
                await persist(saved.filter((_example, i) => i !== index));
                select({ kind: 'new' });
            } catch (error) {
                setStatus(error instanceof Error ? error.message : String(error), 'error');
            }
        };

        const renderResult = (outcome: RunOutcome, example: Example) => {
            const rows = partKeys(activeSource()).map((key) => {
                const got = outcome.results[key];
                const want = example.expected?.[key];
                if (!got && !want) return null;
                let verdict = h('span', { className: 'dim' }, got ? 'no expected value' : 'not run');
                if (got && want) {
                    verdict = got.answer === want ? h('span', { className: 'ok' }, '✓ matches') : h('span', { className: 'error' }, `✗ expected ${want}`);
                }
                return h(
                    'tr',
                    null,
                    h('td', null, partName(key)),
                    h('td', null, got ? h('span', { className: 'result-answer' }, got.answer) : h('span', { className: 'dim' }, 'n/a')),
                    h('td', { className: 'num' }, got ? formatMs(got.timeMs) : ''),
                    h('td', null, verdict),
                );
            });
            replace(
                result,
                h(
                    'p',
                    { className: outcome.success ? 'ok' : 'error' },
                    outcome.success ? `✓ ran '${example.name}'` : '✗ failed',
                    h('span', { className: 'dim' }, ` · ${formatMs(outcome.durationMs)} total`),
                ),
                h(
                    'table',
                    { className: 'results' },
                    h('thead', null, h('tr', null, h('th', null, 'part'), h('th', null, 'answer'), h('th', null, 'time'), h('th', null, 'check'))),
                    h('tbody', null, rows),
                ),
                outcome.error ? h('pre', { className: 'error', style: 'margin-top: 8px' }, outcome.error) : null,
                outcome.logs.trim()
                    ? h(
                        'details',
                        { open: !outcome.success, style: 'margin-top: 8px' },
                        h('summary', null, 'console output'),
                        h('pre', null, outcome.logs.trimEnd()),
                    )
                    : null,
            );
        };

        const run = async () => {
            const example = current();
            if (!example.input.trim()) return setStatus('nothing to run: the input is empty', 'error');
            controller = new AbortController();
            cancelButton.style.display = '';
            live.clear();
            replace(result, h('p', { className: 'dim' }, h('span', { className: 'spinner' }), ' running…'));
            setStatus('');
            const outcome = await actions.runExample({ part: part.value as Part, input: example.input }, controller.signal, {
                onLog: (line) => live.append(line),
            });
            cancelButton.style.display = 'none';
            if (outcome) renderResult(outcome, example);
            else if (controller.signal.aborted) replace(result, h('p', { className: 'dim' }, 'cancelled.'));
            else replace(result, h('pre', { className: 'error' }, getState().lastError ?? 'run failed'));
            controller = null;
        };

        const load = async (force = false) => {
            const { puzzle } = getState();
            if (!puzzle || !activeSource()) return;
            const key = refKey(puzzle);
            if (!force && key === loadedFor) return;
            loadedFor = key;
            part.sync();
            renderExpected();
            debugButton.style.display = activeSource()?.capabilities.debug === false ? 'none' : '';
            try {
                const [examples, description] = await Promise.all([api.examples(puzzle), api.description(puzzle)]);
                if (loadedFor !== key) return;
                saved = examples;
                suggested = description ? suggestionsFrom(description.markdown) : [];
                select(saved.length ? { kind: 'saved', index: 0 } : suggested.length ? { kind: 'suggested', index: 0 } : { kind: 'new' });
            } catch (error) {
                loadedFor = '';
                setStatus(error instanceof Error ? error.message : String(error), 'error');
            }
        };

        container.append(
            h(
                'div',
                { className: 'panel' },
                h(
                    'div',
                    { className: 'toolbar' },
                    h('span', { className: 'group' }, h('span', { className: 'dim' }, 'example:'), picker),
                    h('span', { className: 'group' }, runButton, debugButton, part),
                    h('span', { className: 'group' }, saveButton, deleteButton, newButton),
                    h('span', { className: 'spacer' }),
                    status,
                    cancelButton,
                ),
                h(
                    'div',
                    { className: 'body tests' },
                    h(
                        'div',
                        { className: 'tests-fields' },
                        h('label', null, 'name ', name),
                        h('label', null, 'expected ', expectedBox),
                        h('span', { className: 'spacer' }),
                        lineInfo,
                    ),
                    input,
                    result,
                    live.element,
                ),
            ),
        );

        const unsubscribes = [
            subscribe(() => load(), ['puzzle', 'hub']),
            subscribe(() => {
                // puzzle text may have been fetched after we loaded: pick up new suggestions
                const { detail } = getState();
                if (detail?.hasDescription && suggested.length === 0) load(true);
            }, ['detail']),
            subscribe(() => {
                runButton.disabled = debugButton.disabled = getState().running;
            }, ['running']),
        ];
        renderExpected();
        load();

        return { dispose: () => unsubscribes.forEach((fn) => fn()) };
    },
};
