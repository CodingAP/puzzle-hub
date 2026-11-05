/**
 * frontend/src/dashboard.ts
 *
 * the full page hub: one tab per puzzle site, its totals and puzzle grid, and bulk download tools
 */

import { api, onUnauthorized } from './api.ts';
import { h, replace } from './dom.ts';
import { createPuzzleGrid } from './grid.ts';
import { settings } from './settings.ts';
import { actions, getState, puzzleLabel, sourceInfo, subscribe } from './state.ts';
import type { BulkStatus, PuzzleRef } from './types.ts';

export const createDashboard = (root: HTMLElement, openEditor: (puzzle: PuzzleRef) => void): { refresh(): void } => {
    const heading = h('span', null, 'Puzzle Hub');
    const sourceRow = h('p', { className: 'text-center source-row' });
    const totals = h('p', { className: 'text-center totals' });
    const grid = createPuzzleGrid(openEditor, { followEditor: false });

    // bulk download tool
    const onlyMissing = h('input', { type: 'checkbox', checked: true, id: 'bulk-missing' });
    const inputs = h('input', { type: 'checkbox', checked: true, id: 'bulk-inputs' });
    const descriptions = h('input', { type: 'checkbox', checked: true, id: 'bulk-descriptions' });
    const descriptionsLabel = h('label', { htmlFor: 'bulk-descriptions' }, descriptions, ' puzzle text');
    const startButton = h('button', { className: 'link', onClick: () => start() }, 'download all inputs');
    const progress = h('div', { className: 'bulk-progress dim' });
    const tools = h(
        'div',
        { className: 'toolbar' },
        startButton,
        h('label', { htmlFor: 'bulk-missing' }, onlyMissing, ' only missing'),
        h('label', { htmlFor: 'bulk-inputs' }, inputs, ' inputs'),
        descriptionsLabel,
    );
    let poll: number | undefined;
    let lastStatus: BulkStatus | null = null;

    const shown = () => sourceInfo(getState().dashboardSource);

    const renderProgress = (status: BulkStatus | null = lastStatus) => {
        lastStatus = status;
        const source = shown();
        const canDownload = !!source?.capabilities.fetchInputs;
        tools.style.display = canDownload ? '' : 'none';
        startButton.disabled = !!status?.running;
        if (!source) return replace(progress);
        if (!canDownload) {
            return replace(progress, `${source.provider.name} inputs cannot be downloaded automatically: paste them into the input panel of each puzzle.`);
        }
        const mine = status && status.source === source.id ? status : null;
        const summary = mine?.total ? `${mine.done}/${mine.total}` : '';
        const errors = mine?.errors.length
            ? h(
                'details',
                null,
                h('summary', { className: 'error' }, `${mine.errors.length} error${mine.errors.length === 1 ? '' : 's'}`),
                h('pre', null, mine.errors.join('\n')),
            )
            : null;
        if (status?.running && !mine) {
            replace(progress, h('span', { className: 'spinner' }), ` a download for ${sourceInfo(status.source)?.name ?? status.source} is running…`);
        } else if (mine?.running) {
            replace(progress, h('span', { className: 'spinner' }), ` downloading ${summary}${mine.current ? ` · ${mine.current}` : ''}`, errors);
        } else if (mine?.finishedAt) {
            replace(
                progress,
                h('span', { className: 'ok' }, '✓ '),
                `finished ${summary}: ${mine.downloaded} downloaded, ${mine.skipped} already present`,
                errors,
            );
        } else {
            const needs = source.credential && !source.credential.configured ? ` needs your ${source.credential.label} (settings panel in the editor).` : '';
            replace(
                progress,
                `downloads the input${
                    source.capabilities.fetchDescription ? ' (and puzzle text)' : ''
                } of every published ${source.provider.name} puzzle; nothing is committed to git.${needs}`,
            );
        }
    };

    const refreshStatus = async () => {
        try {
            const status = await api.bulkStatus();
            renderProgress(status);
            if (!status.running) {
                clearInterval(poll);
                poll = undefined;
                if (status.finishedAt) grid.refresh();
            } else {
                poll ??= setInterval(refreshStatus, 1000);
            }
        } catch (error) {
            replace(progress, h('span', { className: 'error' }, error instanceof Error ? error.message : String(error)));
            clearInterval(poll);
            poll = undefined;
        }
    };

    const start = async () => {
        const source = shown();
        if (!source) return;
        startButton.disabled = true;
        try {
            renderProgress(await api.bulkStart(source.id, { onlyMissing: onlyMissing.checked, inputs: inputs.checked, descriptions: descriptions.checked }));
            poll ??= setInterval(refreshStatus, 1000);
        } catch (error) {
            replace(progress, h('span', { className: 'error' }, error instanceof Error ? error.message : String(error)));
            startButton.disabled = false;
        }
    };

    const starsOf = (source: string) =>
        (getState().groups[source] ?? []).reduce((sum, group) => ({ stars: sum.stars + group.stars, max: sum.max + group.maxStars }), { stars: 0, max: 0 });

    const renderSources = () => {
        const { hub } = getState();
        const source = shown();
        heading.textContent = hub?.title ?? 'Puzzle Hub';
        replace(
            sourceRow,
            source
                ? [
                    h('a', {
                        className: 'header platform-heading',
                        href: source.provider.home,
                        target: '_blank',
                        rel: 'noopener',
                        title: `open ${source.provider.name}`,
                    }, source.name),
                    (hub?.sources.length ?? 0) > 1 ? h('span', { className: 'dim platform-hint' }, 'switch platform from the menu in the top right') : null,
                ]
                : null,
        );
        descriptionsLabel.style.display = source?.capabilities.fetchDescription ? '' : 'none';
    };

    let needsToken = false;
    onUnauthorized(() => {
        if (needsToken || getState().hub) return;
        needsToken = true;
        renderTotals();
    });

    const renderTotals = () => {
        const { hub, dashboardSource } = getState();
        const source = shown();
        if (!hub) {
            if (!needsToken) return replace(totals, 'loading…');
            // a fresh browser (or a new address) has no api token yet: ask for it right here
            const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'api token' });
            const save = async () => {
                settings.set({ token: input.value.trim() });
                needsToken = false;
                renderTotals();
                await actions.loadHub();
                refreshStatus();
            };
            input.addEventListener('keydown', (event) => event.key === 'Enter' && save());
            return replace(
                totals,
                h('span', { className: 'dim' }, settings.get().token ? 'that api token was not accepted. ' : 'this hub is private: enter its api token. '),
                input,
                ' ',
                h('button', { className: 'link', onClick: save }, 'unlock'),
            );
        }
        if (!source) return replace(totals, h('span', { className: 'dim' }, 'no puzzle repositories are mounted yet: list them in hub.json (see the readme).'));
        const here = starsOf(source.id);
        const last = (dashboardSource && settings.get().lastBySource[dashboardSource]) || null;
        const lastSource = sourceInfo(last?.source);
        replace(
            totals,
            h('span', { className: 'claimed-stars' }, `${here.stars}/${here.max}`),
            ' stars',
            ' · ',
            source.repository ? [h('a', { className: 'bracket', href: source.repository, target: '_blank', rel: 'noopener' }, 'repository'), ' '] : null,
            h(
                'a',
                { className: 'bracket', href: last ? `#/${last.source}/${last.group}/${last.puzzle}` : `#/editor/${source.id}` },
                last
                    ? `open editor: ${(getState().groups[last.source]?.length ?? 0) > 1 ? `${last.group} ` : ''}${
                        puzzleLabel(lastSource, last.puzzle).toLowerCase()
                    }`
                    : 'open editor',
            ),
        );
    };

    replace(
        root,
        h(
            'div',
            { className: 'dashboard' },
            h(
                'p',
                { className: 'header text-center dashboard-title' },
                h('span', { className: 'deco' }, '-- '),
                heading,
                h('span', { className: 'deco' }, ' --'),
            ),
            sourceRow,
            totals,
            grid.element,
            h('div', { className: 'tools' }, h('p', { className: 'header' }, 'tools'), tools, progress),
        ),
    );

    const render = () => {
        renderSources();
        renderTotals();
        renderProgress();
    };

    subscribe(render, ['hub', 'groups']);
    subscribe(() => {
        render();
        const source = getState().dashboardSource;
        if (source) grid.show(source);
    }, ['dashboardSource']);
    subscribe(renderTotals, ['puzzle']);
    settings.onChange((_next, changed) => changed.includes('lastPuzzle') && renderTotals());
    render();
    refreshStatus();

    return {
        refresh: () => {
            const source = getState().dashboardSource;
            if (source) grid.show(source, undefined, true);
            if (!poll) refreshStatus();
        },
    };
};
