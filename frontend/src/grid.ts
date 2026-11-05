/**
 * frontend/src/grid.ts
 *
 * the puzzle browser shared by the dashboard and the puzzles panel: pick a group (year, event...) of a source,
 * then a card per puzzle with its title, stars and what is on disk
 */

import { api } from './api.ts';
import { clear, h, replace, stars } from './dom.ts';
import { getState, puzzleLabel, sourceInfo, subscribe } from './state.ts';
import type { PuzzleRef, PuzzleSummary } from './types.ts';

export interface PuzzleGrid {
    element: HTMLElement;
    /** shows a group of a source (the newest one with stars when the group is left out) */
    show(source: string, group?: string, force?: boolean): Promise<void>;
    /** reloads what is currently shown */
    refresh(): Promise<void>;
    dispose(): void;
}

export const createPuzzleGrid = (onSelect: (puzzle: PuzzleRef) => void, options: { followEditor: boolean }): PuzzleGrid => {
    let shownSource = '';
    let shownGroup = '';
    const cache = new Map<string, PuzzleSummary[]>();

    const groupRow = h('p', { className: 'year-selector-row' });
    const starCount = h('p', { className: 'star-count' });
    const grid = h('div', { className: 'day-grid' });
    const element = h('div', { className: 'puzzle-grid' }, groupRow, starCount, grid);

    const groupsOf = (source: string) => getState().groups[source] ?? [];

    const defaultGroup = (source: string) => {
        const groups = groupsOf(source);
        const active = getState().puzzle;
        if (active?.source === source && groups.some((group) => group.id === active.group)) return active.group;
        return ([...groups].reverse().find((group) => group.stars > 0) ?? groups.at(-1))?.id ?? '';
    };

    const renderGroups = () => {
        const groups = groupsOf(shownSource);
        clear(groupRow);
        if (groups.length > 1) {
            groups.forEach((entry, index) => {
                if (index > 0) groupRow.append(' · ');
                groupRow.append(
                    h(
                        'a',
                        { className: `bracket year-selector${entry.id === shownGroup ? ' current' : ''}`, onClick: () => show(shownSource, entry.id) },
                        entry.label,
                    ),
                );
            });
        }
        const entry = groups.find((item) => item.id === shownGroup);
        replace(starCount, 'Stars: ', h('span', { className: 'claimed-stars' }, `${entry?.stars ?? 0}/${entry?.maxStars ?? 0}`));
    };

    const renderGrid = (puzzles: PuzzleSummary[]) => {
        const active = getState().puzzle;
        const source = sourceInfo(shownSource);
        clear(grid);
        grid.classList.toggle('days-12', puzzles.length <= 12);
        if (puzzles.length === 0) return replace(grid, h('div', { className: 'empty' }, 'nothing here yet.'));
        for (const puzzle of puzzles) {
            const ref: PuzzleRef = { source: shownSource, group: shownGroup, puzzle: puzzle.puzzle };
            const isActive = active?.source === shownSource && active.group === shownGroup && active.puzzle === puzzle.puzzle;
            const started = puzzle.title !== null || puzzle.hasSolution;
            const label = puzzleLabel(source, puzzle.puzzle);
            const stop = (event: Event) => event.stopPropagation();
            const have = puzzle.inputs.filter(Boolean).length;
            const inputLabel = puzzle.inputs.length > 1 ? `inputs ${have}/${puzzle.inputs.length}` : `input ${puzzle.hasInput ? '✓' : '·'}`;
            grid.append(h(
                'div',
                { className: `day${isActive ? ' active' : ''}`, onClick: () => onSelect(ref) },
                h('span', { className: `header title${started ? '' : ' disabled'}` }, puzzle.title ? `${label} - ${puzzle.title}` : label),
                stars(puzzle.stars, source?.parts ?? 2),
                h('br'),
                source?.repository
                    ? h('a', {
                        className: `bracket${puzzle.hasSolution ? '' : ' disabled'}`,
                        href: `${source.repository}/tree/main/${puzzle.path}`,
                        target: '_blank',
                        rel: 'noopener',
                        onClick: stop,
                    }, 'Source Code')
                    : h('span', { className: 'dim' }, puzzle.hasSolution ? 'solution ✓' : 'no solution yet'),
                h(
                    'div',
                    { className: 'day-files dim' },
                    h('span', { title: puzzle.hasInput ? 'input downloaded' : 'input missing' }, inputLabel),
                    ' ',
                    source?.capabilities.fetchDescription
                        ? h(
                            'span',
                            { title: puzzle.hasDescription ? 'puzzle text downloaded' : 'no puzzle text yet' },
                            puzzle.hasDescription ? 'text ✓' : 'text ·',
                        )
                        : null,
                ),
            ));
        }
    };

    const show = async (source: string, group?: string, force = false) => {
        shownSource = source;
        shownGroup = group && groupsOf(source).some((entry) => entry.id === group) ? group : defaultGroup(source);
        renderGroups();
        if (!shownGroup) return replace(grid, h('div', { className: 'empty' }, getState().hub ? 'this source has no puzzles yet.' : 'loading…'));
        const key = `${source}/${shownGroup}`;
        if (!force && cache.has(key)) return renderGrid(cache.get(key)!);
        if (!cache.has(key)) replace(grid, h('div', { className: 'empty' }, 'loading…'));
        try {
            const puzzles = await api.group(source, shownGroup);
            cache.set(key, puzzles);
            if (`${shownSource}/${shownGroup}` === key) renderGrid(puzzles);
        } catch (error) {
            replace(grid, h('div', { className: 'empty error' }, error instanceof Error ? error.message : String(error)));
        }
    };

    const unsubscribes = [
        // groups arrive after the hub loads and change when stars do
        subscribe(() => {
            if (shownSource && !shownGroup) show(shownSource);
            else renderGroups();
        }, ['groups']),
        // a detail refresh means something may have changed (fetch, stars) so reload that group
        subscribe(() => {
            const { puzzle } = getState();
            if (!puzzle) return;
            if (puzzle.source === shownSource && puzzle.group === shownGroup) show(shownSource, shownGroup, true);
            else cache.delete(`${puzzle.source}/${puzzle.group}`);
        }, ['detail']),
        subscribe(() => {
            const { puzzle } = getState();
            if (!puzzle) return;
            if (options.followEditor) show(puzzle.source, puzzle.group);
            else if (shownSource) show(shownSource, shownGroup); // repaint the active marker
        }, ['puzzle']),
    ];

    return {
        element,
        show,
        refresh: () => (shownSource ? show(shownSource, shownGroup, true) : Promise.resolve()),
        dispose: () => unsubscribes.forEach((fn) => fn()),
    };
};
