/**
 * frontend/src/panels/puzzles.ts
 *
 * the puzzle browser as a panel inside the editor view; it follows the source of the puzzle being edited
 */

import { h } from '../dom.ts';
import { createPuzzleGrid } from '../grid.ts';
import { actions, getState } from '../state.ts';
import type { PanelDefinition } from '../workspace.ts';

export const puzzlesPanel: PanelDefinition = {
    id: 'puzzles',
    title: 'Puzzles',
    create(container) {
        const grid = createPuzzleGrid((puzzle) => actions.selectPuzzle(puzzle), { followEditor: true });
        container.append(h('div', { className: 'panel' }, h('div', { className: 'body' }, grid.element)));
        const active = getState().puzzle;
        if (active) grid.show(active.source, active.group);
        return { dispose: () => grid.dispose() };
    },
};
