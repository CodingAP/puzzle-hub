/**
 * frontend/src/panels/runner.ts
 *
 * run / profile / debug / submit controls, live console output, and the latest result
 */

import { debugStore } from '../debugstore.ts';
import { formatMs, h, replace } from '../dom.ts';
import { createLiveLog } from '../livelog.ts';
import { settings } from '../settings.ts';
import { actions, activeSource, getState, partKeys, partName, partOptions, puzzleLabel, subscribe, validPart } from '../state.ts';
import type { Part, RunOutcome, SubmitOutcome } from '../types.ts';
import type { PanelDefinition } from '../workspace.ts';

/** a part <select> whose options follow the active source (two parts, three, or a single one) */
export const partSelect = (value: Part): HTMLSelectElement & { sync(): void } => {
    const select = h('select', { title: 'which part to run' }) as HTMLSelectElement & { sync(): void };
    let wanted = value;
    select.addEventListener('change', () => (wanted = select.value));
    select.sync = () => {
        const source = activeSource();
        const options = partOptions(source);
        const signature = options.map((option) => option.join('=')).join('|');
        if (select.dataset.signature !== signature) {
            select.dataset.signature = signature;
            replace(select, options.map(([id, label]) => h('option', { value: id }, label)));
        }
        select.value = validPart(source, wanted);
        select.style.display = options.length > 1 ? '' : 'none';
    };
    select.sync();
    return select;
};

export const runnerPanel: PanelDefinition = {
    id: 'runner',
    title: 'Runner',
    create(container, { workspace }) {
        const current = settings.get();
        const runPart = partSelect(current.defaultPart);
        const iterations = h('input', {
            type: 'number',
            min: '1',
            max: '1000',
            value: String(current.defaultIterations),
            style: 'width: 70px',
            title: 'iterations',
        });
        const submitPart = partSelect(current.defaultPart);
        const record = h('input', { type: 'checkbox', checked: current.defaultRecord, id: 'runner-record' });
        const recordLabel = h('label', { htmlFor: 'runner-record' }, 'record only');
        const summary = h('div', { className: 'run-summary' });
        const live = createLiveLog();
        const status = h('span', { className: 'dim run-status' });

        let controller: AbortController | null = null;
        let ticker: number | undefined;

        const runButton = h('button', { className: 'link', onClick: () => run('run') }, '▶ run');
        const profileButton = h('button', { className: 'link', onClick: () => run('profile') }, '⏱ profile');
        const debugButton = h('button', {
            className: 'link',
            title: 'open the debugger panel and start this run under it',
            onClick: () => {
                workspace.open('debugger');
                debugStore.requestSession({ part: runPart.value as Part });
            },
        }, '🐞 debug');
        const submitButton = h('button', { className: 'link', onClick: () => submit() }, '⬆ submit');
        const cancelButton = h('button', { className: 'link error', onClick: () => controller?.abort(), style: 'display: none' }, 'cancel');

        const startTicker = (label: string) => {
            const started = performance.now();
            const tick = () => {
                status.textContent = `${label}… ${((performance.now() - started) / 1000).toFixed(1)} s · ${live.lines} line${live.lines === 1 ? '' : 's'}`;
            };
            tick();
            ticker = setInterval(tick, 200);
        };
        const stopTicker = () => {
            clearInterval(ticker);
            ticker = undefined;
        };

        const run = async (mode: 'run' | 'profile') => {
            controller = new AbortController();
            live.clear();
            replace(summary);
            startTicker(mode === 'profile' ? 'profiling' : 'running');
            const options = mode === 'profile'
                ? { part: 'all' as Part, iterations: Math.max(1, Number(iterations.value) || 1), updateReadme: true, commit: settings.get().profilePush }
                : { part: runPart.value as Part, iterations: 1 };
            await actions.run(options, controller.signal, { onLog: (line) => live.append(line) });
            stopTicker();
            if (controller.signal.aborted) {
                status.textContent = 'cancelled';
                replace(summary, h('p', { className: 'dim' }, 'cancelled: the solution process was stopped.'));
            }
            controller = null;
        };

        const submit = async () => {
            const source = activeSource();
            const target = getState().puzzle;
            if (!target) return;
            const part = submitPart.value as Part;
            const recordOnly = record.checked || !source?.capabilities.submit;
            if (settings.get().confirmSubmit && !recordOnly) {
                // submitting every part sends one new answer per press: the first part that is not solved yet
                const label = part === 'all' ? (source && source.parts > 1 ? 'the next unsolved part' : 'the answer') : `part ${part}`;
                const where = `${(getState().groups[target.source]?.length ?? 0) > 1 ? `${target.group} ` : ''}${
                    puzzleLabel(source, target.puzzle).toLowerCase()
                }`;
                if (!confirm(`submit ${label} of ${where} to ${source?.provider.name ?? 'the site'}?`)) return;
            }
            live.clear();
            replace(
                summary,
                h('p', { className: 'dim' }, h('span', { className: 'spinner' }), recordOnly ? ' running and recording…' : ' running and submitting…'),
            );
            await actions.submit({ part, record: recordOnly });
        };

        const renderRun = (run: RunOutcome) => {
            const rows = partKeys(activeSource()).map((key) => {
                const result = run.results[key];
                return h(
                    'tr',
                    null,
                    h('td', null, partName(key)),
                    h('td', null, result ? h('span', { className: 'result-answer' }, result.answer) : h('span', { className: 'dim' }, 'n/a')),
                    h('td', { className: 'num' }, result ? formatMs(result.timeMs) : ''),
                );
            });
            replace(
                summary,
                h(
                    'p',
                    { className: run.success ? 'ok' : 'error' },
                    run.success ? '✓ finished' : run.cancelled ? '■ cancelled' : '✗ failed',
                    h(
                        'span',
                        { className: 'dim' },
                        ` · ${run.iterations} iteration${run.iterations === 1 ? '' : 's'} · ${formatMs(run.durationMs)} total · ${run.logLines} log line${
                            run.logLines === 1 ? '' : 's'
                        }${run.readmeUpdated ? ' · readme updated' : ''}`,
                    ),
                ),
                h(
                    'table',
                    { className: 'results' },
                    h('thead', null, h('tr', null, h('th', null, 'part'), h('th', null, 'answer'), h('th', null, 'avg time'))),
                    h('tbody', null, rows),
                ),
                run.error && !run.cancelled ? h('pre', { className: 'error', style: 'margin-top: 8px' }, run.error) : null,
                run.git
                    ? h('p', { className: run.git.pushed || !run.git.committed ? 'ok' : 'error', style: 'margin-top: 8px' }, `git: ${run.git.message}`)
                    : null,
            );
            status.textContent = run.success ? `done in ${formatMs(run.durationMs)}` : run.cancelled ? 'cancelled' : 'failed';
        };

        const renderSubmit = (result: SubmitOutcome) => {
            const rows = partKeys(activeSource()).map((key) => {
                const part = result[key];
                if (!part) return null;
                return h(
                    'tr',
                    null,
                    h('td', null, partName(key)),
                    h('td', null, h('span', { className: 'result-answer' }, part.answer)),
                    h('td', { className: part.correct === true ? 'ok' : part.correct === false ? 'error' : 'dim' }, part.message),
                );
            });
            replace(
                summary,
                h(
                    'table',
                    { className: 'results' },
                    h('thead', null, h('tr', null, h('th', null, 'part'), h('th', null, 'answer'), h('th', null, 'result'))),
                    h('tbody', null, rows),
                ),
            );
            status.textContent = '';
        };

        /** the controls follow what the active source can do */
        const syncSource = () => {
            const source = activeSource();
            runPart.sync();
            submitPart.sync();
            const canSubmit = !!source?.capabilities.submit;
            submitButton.textContent = canSubmit ? '⬆ submit' : '✓ record answer';
            submitButton.title = canSubmit
                ? `run and send the answer to ${source?.provider.name}`
                : `${source?.provider.name ?? 'this site'} takes answers on its own page: check it there, then record it here to keep the star`;
            record.style.display = recordLabel.style.display = canSubmit ? '' : 'none';
            recordLabel.title = `store the answer as correct without contacting ${source?.provider.name ?? 'the site'}`;
            debugButton.style.display = source?.capabilities.debug === false ? 'none' : '';
        };

        const render = () => {
            const { running, lastRun, lastSubmit, lastError, detail } = getState();
            const canRun = !running && !!detail?.hasSolution;
            for (const button of [runButton, profileButton, debugButton, submitButton]) button.disabled = !canRun;
            cancelButton.style.display = running && controller ? '' : 'none';

            if (running) return;
            if (lastError) {
                replace(summary, h('pre', { className: 'error' }, lastError));
                status.textContent = 'failed';
            } else if (lastSubmit) renderSubmit(lastSubmit);
            else if (lastRun) renderRun(lastRun);
            else if (detail && !detail.hasSolution) {
                replace(summary, h('p', { className: 'dim' }, 'no solution yet: fetch the puzzle from the code panel first.'));
            } else if (!summary.childElementCount) {
                replace(
                    summary,
                    h('p', { className: 'dim' }, 'press run to execute the solution against your input. console output streams in below as it happens.'),
                );
            }
        };

        container.append(
            h(
                'div',
                { className: 'panel' },
                h(
                    'div',
                    { className: 'toolbar' },
                    h('span', { className: 'group' }, runButton, runPart),
                    h('span', { className: 'group' }, profileButton, iterations, h('span', { className: 'dim' }, 'iterations')),
                    h('span', { className: 'group' }, debugButton),
                    h(
                        'span',
                        { className: 'group' },
                        submitButton,
                        submitPart,
                        record,
                        recordLabel,
                    ),
                    h('span', { className: 'spacer' }),
                    status,
                    cancelButton,
                ),
                h('div', { className: 'body tight runner' }, summary, live.element),
            ),
        );

        const unsubscribes = [
            subscribe(render, ['running', 'lastRun', 'lastSubmit', 'lastError', 'detail']),
            subscribe(syncSource, ['hub']),
            subscribe(() => {
                live.clear();
                replace(summary);
                status.textContent = '';
                syncSource();
            }, ['puzzle']),
            settings.onChange((next, changed) => {
                if (changed.includes('defaultPart')) runPart.value = submitPart.value = validPart(activeSource(), next.defaultPart);
                if (changed.includes('defaultIterations')) iterations.value = String(next.defaultIterations);
                if (changed.includes('defaultRecord')) record.checked = next.defaultRecord;
            }),
        ];
        syncSource();
        render();

        return { dispose: () => unsubscribes.forEach((fn) => fn()) };
    },
};
