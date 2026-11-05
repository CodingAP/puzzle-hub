/**
 * backend/src/providers/manual.ts
 *
 * for any puzzle set the hub has no site integration for: nothing is downloaded, inputs and text are whatever is on
 * disk (paste them in the browser or drop the files in), and groups and puzzles come from the manifest or the folders
 */

import type { Provider } from './mod.ts';

export const manual: Provider = {
    id: 'manual',
    name: 'Manual',
    home: '',
    labels: { group: 'group', puzzle: 'puzzle' },
    parts: 2,
    perPartInput: false,
    credential: null,
    groups: () => [],
    puzzleUrl: () => '',
    heading: (group, puzzle, title) => `# ${group} - ${puzzle}: ${title}`,
};
