/**
 * frontend/src/main.ts
 *
 * boots the app: settings, workspace, top bar, and url hash syncing
 */

import { onUnauthorized } from './api.ts';
import { h } from './dom.ts';
import { createDashboard } from './dashboard.ts';
import { codePanel } from './panels/code.ts';
import { debuggerPanel } from './panels/debugger.ts';
import { inputPanel } from './panels/input.ts';
import { puzzlePanel } from './panels/puzzle.ts';
import { puzzlesPanel } from './panels/puzzles.ts';
import { readmePanel } from './panels/readme.ts';
import { runnerPanel } from './panels/runner.ts';
import { runsPanel } from './panels/runs.ts';
import { settingsPanel } from './panels/settings.ts';
import { submissionsPanel } from './panels/submissions.ts';
import { testsPanel } from './panels/tests.ts';
import { settings } from './settings.ts';
import { actions, firstPuzzle, getState, sourceInfo, subscribe } from './state.ts';
import { activeThemeId, applyTheme, onSystemModeChange, resolveMode, SOURCE_THEMES } from './themes.ts';
import { createTopbar } from './topbar.ts';
import type { PuzzleRef } from './types.ts';
import { initWisdom } from './wisdom.ts';
import { Workspace } from './workspace.ts';

type View = 'dashboard' | 'editor';

interface Route {
    view: View;
    puzzle: PuzzleRef | null;
    /** #/editor/<source>: open the editor somewhere sensible in that source */
    source: string | null;
}

/** #/ is the dashboard, #/editor the editor, #/<source>/<group>/<puzzle> a puzzle (#/<year>/<day> still works for advent of code) */
const parseRoute = (): Route => {
    const segments = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (segments[0] === 'editor') return { view: 'editor', puzzle: null, source: segments[1] ?? null };
    if (segments.length === 3 && /^\d+$/.test(segments[2])) {
        return { view: 'editor', puzzle: { source: segments[0], group: segments[1], puzzle: Number(segments[2]) }, source: null };
    }
    if (segments.length === 2 && /^\d{4}$/.test(segments[0]) && /^\d+$/.test(segments[1])) {
        const legacy = getState().hub?.sources.find((source) => source.provider.id === 'advent-of-code');
        if (legacy) return { view: 'editor', puzzle: { source: legacy.id, group: segments[0], puzzle: Number(segments[1]) }, source: null };
    }
    return { view: 'dashboard', puzzle: null, source: null };
};

const puzzleHash = (puzzle: PuzzleRef) => `#/${encodeURIComponent(puzzle.source)}/${encodeURIComponent(puzzle.group)}/${puzzle.puzzle}`;

const PARTICLE_GLYPHS: Record<string, string[]> = {
    aoc: ['*'],
    nord: ['❄', '*'],
    dracula: ['*'],
    hacker: ['0', '1', '0', '1', 'ｱ', 'ｶ', 'ﾊ', 'ﾏ', 'ﾔ', 'ﾗ', '7', '3'],
    synthwave: ['✦', '✧', '·'],
    aero: [''], // bubbles are drawn with css
    ec: ['✦', '·', '✧', '·'],
    aquaq: ['°', '·', '•', '°'],
};

/**
 * the falling snow from the old site, now an overlay the themes restyle (bubbles rise in aero, glyphs rain in hacker)
 */
const renderSnowflakes = () => {
    const container = document.querySelector<HTMLElement>('#snowflakes');
    if (!container) return;
    const { snowflakes } = settings.get();
    const theme = activeThemeId();
    container.classList.toggle('hidden', !snowflakes);
    if (!snowflakes) return;
    if (container.dataset.theme === theme && container.childElementCount) return;
    container.dataset.theme = theme;
    container.replaceChildren();
    const glyphs = PARTICLE_GLYPHS[theme] ?? ['*'];
    const count = theme === 'aero' ? 28 : theme === 'hacker' ? 90 : theme === 'ec' ? 45 : 120;
    for (let i = 0; i < count; i++) {
        container.append(h('div', {
            className: `snowflake snowflake-${Math.floor(Math.random() * 4)}`,
            style: `left: ${Math.random() * 100}vw; animation-delay: ${Math.random() * -30}s; --size: ${0.5 + Math.random() * 1.2}`,
        }, glyphs[Math.floor(Math.random() * glyphs.length)]));
    }
};

const boot = async () => {
    const snowflakes = document.querySelector<HTMLElement>('#snowflakes');
    if (snowflakes) initWisdom(snowflakes);
    const workspaceRoot = document.querySelector<HTMLElement>('#workspace')!;
    let workspace: Workspace | null = null;
    let view: View | null = null;

    /** the chosen theme, or the look of the site whose puzzles are on screen when that option is on */
    const syncTheme = () => {
        const { theme, themeMode, themeFollowsSource } = settings.get();
        const { puzzle, dashboardSource } = getState();
        const source = sourceInfo(view === 'editor' ? puzzle?.source : dashboardSource);
        const wanted = (themeFollowsSource && source && SOURCE_THEMES[source.provider.id]) || theme;
        const mode = resolveMode(themeMode);
        applyTheme(wanted, mode);
        workspace?.setDark(mode === 'dark');
        localStorage.setItem('hub.theme.active', activeThemeId());
        localStorage.setItem('hub.theme.mode', mode);
        renderSnowflakes();
    };
    syncTheme();
    settings.onChange((_next, changed) => {
        if (['theme', 'themeMode', 'themeFollowsSource', 'snowflakes'].some((key) => changed.includes(key as keyof typeof _next))) syncTheme();
    });
    subscribe(syncTheme, ['hub', 'puzzle', 'dashboardSource']);
    onSystemModeChange(syncTheme);

    const dashboardRoot = document.querySelector<HTMLElement>('#dashboard')!;
    const topbarRoot = document.querySelector<HTMLElement>('#topbar')!;

    // the dockable editor needs room; phones get the dashboard and a pointer to a bigger screen
    const smallScreen = matchMedia('(max-width: 820px)');
    const notice = h(
        'div',
        { className: 'view mobile-notice hidden' },
        h('p', { className: 'header' }, 'the editor is built for a desktop or laptop screen'),
        h(
            'p',
            null,
            'the dashboard works here: browse the puzzles, check stars, and download inputs. open the editor on a bigger screen to edit and run code.',
        ),
        h(
            'p',
            null,
            h('a', { className: 'bracket', href: '#/' }, 'back to the dashboard'),
            ' ',
            h('button', {
                className: 'link',
                onClick: () => {
                    sessionStorage.setItem('hub.editorAnyway', '1');
                    applyRoute();
                },
            }, 'open the editor anyway'),
        ),
    );
    workspaceRoot.before(notice);
    const editorBlocked = () => smallScreen.matches && !sessionStorage.getItem('hub.editorAnyway');

    // the dock needs a visible container to measure, so it is created the first time the editor is shown
    const ensureWorkspace = () => {
        workspace ??= new Workspace(
            workspaceRoot,
            [puzzlePanel, puzzlesPanel, inputPanel, codePanel, runnerPanel, testsPanel, debuggerPanel, runsPanel, submissionsPanel, readmePanel, settingsPanel],
            [
                { id: 'puzzle' },
                { id: 'puzzles', position: { referencePanel: 'puzzle', direction: 'within' } },
                { id: 'input', position: { referencePanel: 'puzzle', direction: 'within' } },
                { id: 'code', position: { referencePanel: 'puzzle', direction: 'right' }, initialWidth: Math.round(workspaceRoot.clientWidth * 0.6) },
                { id: 'runner', position: { referencePanel: 'code', direction: 'below' }, initialHeight: Math.round(workspaceRoot.clientHeight * 0.35) },
                { id: 'tests', position: { referencePanel: 'runner', direction: 'within' } },
                { id: 'debugger', position: { referencePanel: 'runner', direction: 'within' } },
                { id: 'runs', position: { referencePanel: 'runner', direction: 'within' } },
                { id: 'submissions', position: { referencePanel: 'runner', direction: 'within' } },
                { id: 'readme', position: { referencePanel: 'runner', direction: 'within' } },
            ],
        );
        return workspace;
    };

    const dashboard = createDashboard(dashboardRoot, (puzzle) => {
        location.hash = puzzleHash(puzzle);
    });

    createTopbar(topbarRoot, { getWorkspace: () => workspace });

    const showView = (next: View) => {
        const blocked = next === 'editor' && editorBlocked();
        if (view === next && notice.classList.contains('hidden') === !blocked) return;
        const leavingEditor = view === 'editor' && next === 'dashboard';
        view = next;
        actions.setView(next);
        const editing = getState().puzzle?.source;
        if (leavingEditor && editing) actions.setDashboardSource(editing);
        document.body.classList.toggle('view-dashboard', next === 'dashboard');
        document.body.classList.toggle('view-editor', next === 'editor');
        document.body.classList.toggle('view-notice', blocked);
        dashboardRoot.classList.toggle('hidden', next !== 'dashboard');
        notice.classList.toggle('hidden', !blocked);
        workspaceRoot.classList.toggle('hidden', next !== 'editor' || blocked);
        if (next === 'editor' && !blocked) ensureWorkspace();
        if (next === 'dashboard') dashboard.refresh();
        syncTheme();
    };

    const applyRoute = async () => {
        const route = parseRoute();
        if (route.view === 'dashboard') {
            showView('dashboard');
            return;
        }
        const sources = getState().hub?.sources ?? [];
        const remembered = settings.get().lastPuzzle;
        const known = (puzzle: PuzzleRef | null) => (puzzle && sourceInfo(puzzle.source) ? puzzle : null);
        const target = known(route.puzzle) ??
            (route.source ? (remembered?.source === route.source ? known(remembered) : null) ?? firstPuzzle(route.source) : null) ??
            known(getState().puzzle) ?? known(remembered) ?? (sources[0] ? firstPuzzle(sources[0].id) : null);
        const first = view !== 'editor';
        showView('editor');
        if (editorBlocked() || !target) return;
        await actions.selectPuzzle(target, { force: first && !getState().detail });
    };

    onUnauthorized(() => {
        if (view === 'editor') workspace?.open('settings');
    });

    // keep the hash and the active puzzle in sync both ways while in the editor
    subscribe(() => {
        if (view !== 'editor') return;
        const { puzzle } = getState();
        if (puzzle && location.hash !== puzzleHash(puzzle)) history.replaceState(null, '', puzzleHash(puzzle));
    }, ['puzzle']);

    globalThis.addEventListener('hashchange', () => applyRoute());
    smallScreen.addEventListener('change', () => applyRoute());

    globalThis.addEventListener('beforeunload', (event) => {
        const { dirty, pendingReadme } = getState();
        if (dirty || pendingReadme !== null) event.preventDefault();
    });

    // which sources exist decides what a route means, so the hub loads first
    await actions.loadHub();
    await applyRoute();

    // and when they change later (e.g. after the token is entered) the route is looked at again
    subscribe(() => applyRoute(), ['hub']);
};

boot().catch((error) => {
    console.error(error);
    document.body.prepend(h('div', { className: 'error', style: 'padding: 20px' }, `failed to start: ${error instanceof Error ? error.message : error}`));
});
