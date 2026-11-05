/**
 * frontend/src/topbar.ts
 *
 * navigation, panel/layout menus, and status indicators
 */

import { clear, h, replace, stars } from './dom.ts';
import { actions, activeSource, firstPuzzle, getState, puzzleLabel, sourceInfo, subscribe } from './state.ts';
import type { Workspace } from './workspace.ts';

export interface TopbarOptions {
    getWorkspace: () => Workspace | null;
}

const closeMenus = () => document.querySelectorAll('.menu.open').forEach((menu) => menu.classList.remove('open'));

document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.menu')) closeMenus();
});

const menu = (label: string, build: (dropdown: HTMLElement) => void): HTMLElement => {
    const dropdown = h('div', { className: 'dropdown' });
    const container = h(
        'div',
        { className: 'menu' },
        h('button', {
            className: 'link',
            onClick: (event: Event) => {
                event.stopPropagation();
                const open = container.classList.contains('open');
                closeMenus();
                if (!open) {
                    clear(dropdown);
                    build(dropdown);
                    container.classList.add('open');
                }
            },
        }, `${label} ▾`),
        dropdown,
    );
    return container;
};

const item = (label: string, onClick: () => void, options: { checked?: boolean; disabled?: boolean } = {}) =>
    h(
        'div',
        {
            className: `item${options.disabled ? ' disabled' : ''}`,
            onClick: (event: Event) => {
                event.stopPropagation();
                onClick();
            },
        },
        options.checked === undefined ? '  ' : options.checked ? '☑ ' : '☐ ',
        label,
    );

export const createTopbar = (root: HTMLElement, { getWorkspace }: TopbarOptions): void => {
    const sourceSelect = h('select', { title: 'puzzle site' });
    const groupSelect = h('select', { title: 'group' });
    const puzzleSelect = h('select', { title: 'puzzle' });
    const brand = h('span', null, 'Puzzle Hub');

    const title = h('span', { className: 'puzzle-title' });
    const status = h('span', { className: 'status' });

    const groupsOf = (source: string) => getState().groups[source] ?? [];

    /** jumps to another source, back to where you last were in it when that is known */
    const goSource = (source: string) => {
        const target = firstPuzzle(source);
        if (target) actions.selectPuzzle(target);
    };

    const goGroup = (group: string) => {
        const current = getState().puzzle;
        if (!current) return;
        const info = groupsOf(current.source).find((entry) => entry.id === group);
        if (!info) return;
        actions.selectPuzzle({ source: current.source, group, puzzle: info.puzzles.includes(current.puzzle) ? current.puzzle : info.puzzles[0] });
    };

    sourceSelect.addEventListener('change', () => goSource(sourceSelect.value));
    groupSelect.addEventListener('change', () => goGroup(groupSelect.value));
    puzzleSelect.addEventListener('change', () => {
        const current = getState().puzzle;
        if (current) actions.selectPuzzle({ ...current, puzzle: Number(puzzleSelect.value) });
    });

    /** previous / next puzzle, rolling over into the neighbouring group */
    const step = (delta: number) => {
        const current = getState().puzzle;
        if (!current) return;
        const groups = groupsOf(current.source);
        const groupIndex = groups.findIndex((entry) => entry.id === current.group);
        if (groupIndex === -1) return;
        const index = groups[groupIndex].puzzles.indexOf(current.puzzle) + delta;
        if (index >= 0 && index < groups[groupIndex].puzzles.length) {
            actions.selectPuzzle({ ...current, puzzle: groups[groupIndex].puzzles[index] });
            return;
        }
        const neighbour = groups[groupIndex + delta];
        if (!neighbour) return;
        actions.selectPuzzle({ source: current.source, group: neighbour.id, puzzle: delta < 0 ? neighbour.puzzles.at(-1)! : neighbour.puzzles[0] });
    };

    const panelsMenu = menu('Panels', (dropdown) => {
        const workspace = getWorkspace();
        if (!workspace) return;
        for (const definition of workspace.panels) {
            dropdown.append(item(definition.title, () => {
                workspace.toggle(definition.id);
                closeMenus();
            }, { checked: workspace.isOpen(definition.id) }));
        }
    });

    const layoutMenu = menu('Layout', (dropdown) => {
        const workspace = getWorkspace();
        if (!workspace) return;
        dropdown.append(
            item('Reset to default', () => {
                workspace.reset();
                closeMenus();
            }),
            item(workspace.locked ? 'Unlock layout' : 'Lock layout', () => {
                workspace.setLocked(!workspace.locked);
                closeMenus();
            }, { checked: workspace.locked }),
            item('Save as preset…', () => {
                const name = prompt('preset name?');
                if (name) workspace.savePreset(name.trim());
                closeMenus();
            }),
        );

        const presets = workspace.presetNames();
        if (presets.length) {
            dropdown.append(h('div', { className: 'separator' }), h('div', { className: 'label' }, 'presets (shift-click to delete)'));
            for (const name of presets) {
                dropdown.append(h(
                    'div',
                    {
                        className: 'item',
                        onClick: (event: MouseEvent) => {
                            event.stopPropagation();
                            if (event.shiftKey) {
                                if (confirm(`delete preset '${name}'?`)) workspace.deletePreset(name);
                            } else {
                                workspace.loadPreset(name);
                            }
                            closeMenus();
                        },
                    },
                    '  ',
                    name,
                ));
            }
        }
    });

    replace(
        root,
        h(
            'a',
            { className: 'brand header', href: '#/', title: 'dashboard' },
            h('span', { className: 'deco' }, '-- '),
            brand,
            h('span', { className: 'deco' }, ' --'),
        ),
        h(
            'span',
            { className: 'views' },
            h('a', { className: 'bracket view-link view-link-dashboard', href: '#/' }, 'dashboard'),
            h('a', {
                className: 'bracket view-link view-link-editor',
                href: '#/editor',
            }, 'editor'),
        ),
        h(
            'span',
            { className: 'nav editor-only' },
            sourceSelect,
            h('button', { className: 'link', title: 'previous puzzle', onClick: () => step(-1) }, '<'),
            groupSelect,
            puzzleSelect,
            h('button', { className: 'link', title: 'next puzzle', onClick: () => step(1) }, '>'),
        ),
        title,
        status,
        h(
            'span',
            { className: 'editor-only menus' },
            panelsMenu,
            layoutMenu,
            h('button', { className: 'link', title: 'settings', onClick: () => getWorkspace()?.open('settings') }, '⚙'),
        ),
    );
    title.classList.add('editor-only');

    const fill = (select: HTMLSelectElement, options: [string, string][], value: string) => {
        const signature = options.map((option) => option.join('=')).join('|');
        if (select.dataset.signature !== signature) {
            select.dataset.signature = signature;
            clear(select);
            for (const [id, label] of options) select.append(h('option', { value: id }, label));
        }
        select.value = value;
    };

    const renderNav = () => {
        const { hub, puzzle } = getState();
        brand.textContent = hub?.title ?? 'Puzzle Hub';
        document.title = hub?.title ?? 'Puzzle Hub';
        const sources = hub?.sources ?? [];
        fill(sourceSelect, sources.map((source) => [source.id, source.name]), puzzle?.source ?? '');
        sourceSelect.style.display = sources.length > 1 ? '' : 'none';
        if (!puzzle) return;

        const source = sourceInfo(puzzle.source);
        const groups = groupsOf(puzzle.source);
        fill(groupSelect, groups.map((group) => [group.id, group.label]), puzzle.group);
        groupSelect.style.display = groups.length > 1 ? '' : 'none';
        groupSelect.title = source?.labels.group || 'group';
        const numbers = groups.find((group) => group.id === puzzle.group)?.puzzles ?? [puzzle.puzzle];
        fill(puzzleSelect, numbers.map((number) => [String(number), `${source?.labels.puzzle || 'puzzle'} ${number}`]), String(puzzle.puzzle));
        puzzleSelect.title = source?.labels.puzzle || 'puzzle';
    };

    const renderPuzzle = () => {
        const { puzzle, detail, detailError } = getState();
        renderNav();
        if (!puzzle) return replace(title);

        const source = activeSource();
        const label = puzzleLabel(source, puzzle.puzzle);
        const name = detail ? detail.title : detailError ? 'error' : 'loading…';
        replace(
            title,
            h(
                'a',
                {
                    className: 'header',
                    href: detail?.url || source?.provider.home || '#',
                    target: '_blank',
                    rel: 'noopener',
                    title: `open on ${source?.provider.name ?? 'the site'}`,
                },
                name ? `${label} - ${name}` : label,
            ),
            ' ',
            stars(detail?.stars ?? 0, source?.parts ?? 2),
            ' ',
            detail?.repositoryUrl
                ? h('a', { className: 'dim bracket', href: detail.repositoryUrl, target: '_blank', rel: 'noopener', title: 'source in the repository' }, 'gh')
                : null,
        );
    };

    const renderStatus = () => {
        const { dirty, running, lastError } = getState();
        replace(
            status,
            running ? h('span', { className: 'spinner', title: 'running' }) : null,
            dirty ? h('span', { className: 'dot', title: 'unsaved changes' }) : null,
            lastError
                ? h(
                    'button',
                    { className: 'link error', title: lastError, onClick: () => actions.clearError() },
                    `error: ${lastError.slice(0, 60)}${lastError.length > 60 ? '…' : ''}`,
                )
                : null,
        );
    };

    subscribe(renderPuzzle, ['hub', 'groups', 'puzzle', 'detail', 'detailError']);
    subscribe(renderStatus, ['dirty', 'running', 'lastError']);
    renderPuzzle();
    renderStatus();
};
