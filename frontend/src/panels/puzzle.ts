/**
 * frontend/src/panels/puzzle.ts
 *
 * the puzzle itself: by default the text the hub downloaded next to the solution (fast, offline, later parts once
 * they unlock), or the live page of the site in an iframe (uses your own browser login, where the site allows framing)
 */

import { api } from '../api.ts';
import { formatDate, h, replace } from '../dom.ts';
import { renderMarkdown } from '../markdown.ts';
import { settings } from '../settings.ts';
import { actions, activeSource, getState, refKey, subscribe } from '../state.ts';
import type { PanelDefinition } from '../workspace.ts';

export const puzzlePanel: PanelDefinition = {
    id: 'puzzle',
    title: 'Puzzle',
    create(container) {
        let mode = settings.get().puzzlePanelMode;
        let loadedFor = '';
        let busy = false;

        const info = h('span', { className: 'dim' });
        const link = h('a', { className: 'bracket', target: '_blank', rel: 'noopener' }, 'open on site');
        const text = h('div', { className: 'body description' });
        const frame = h('iframe', { className: 'fill', title: 'puzzle page', referrerPolicy: 'no-referrer' });
        const body = h('div', { className: 'body tight', style: 'display: flex; flex-direction: column' });

        const textButton = h('button', { className: 'link', title: 'puzzle text stored next to the solution', onClick: () => setMode('text') }, 'text');
        const siteButton = h('button', { className: 'link', title: 'the live page of the site', onClick: () => setMode('website') }, 'website');
        const refreshButton = h('button', {
            className: 'link',
            title: 'download the puzzle text again (picks up the next part once the previous one is solved)',
            onClick: () => fetchText(),
        }, 'refresh');
        const reloadButton = h('button', { className: 'link', onClick: () => frame.contentWindow?.location.reload() }, 'reload');

        const setInfo = (value: string, className = 'dim') => {
            info.textContent = value;
            info.className = `${className}${/^https?:/.test(value) ? ' path' : ''}`;
        };

        const renderText = (markdown: string, parts: number, fetchedAt: string | null) => {
            const total = activeSource()?.parts ?? parts;
            text.innerHTML = renderMarkdown(markdown);
            setInfo(
                `${total > 1 ? (parts >= total ? 'all parts' : `part ${parts} of ${total}`) : ''}${
                    fetchedAt ? `${total > 1 ? ' · ' : ''}fetched ${formatDate(fetchedAt)}` : ''
                }`,
            );
        };

        const fetchText = async () => {
            const target = getState().puzzle;
            if (busy || !target) return;
            busy = true;
            setInfo('fetching…');
            try {
                const description = await api.refreshDescription(target);
                if (refKey(target) === refKey(getState().puzzle)) renderText(description.markdown, description.parts, description.fetchedAt);
                await actions.refreshDetail();
            } catch (error) {
                setInfo(error instanceof Error ? error.message : String(error), 'error');
            } finally {
                busy = false;
            }
        };

        const loadText = async () => {
            const target = getState().puzzle;
            const key = refKey(target);
            if (!target || key === loadedFor) return;
            loadedFor = key;
            replace(text, h('div', { className: 'empty' }, 'loading…'));
            setInfo('');
            try {
                const description = await api.description(target);
                if (loadedFor !== key) return;
                if (!description) {
                    const source = activeSource();
                    const canFetch = !!source?.capabilities.fetchDescription;
                    setInfo(canFetch ? 'not fetched yet' : '');
                    replace(
                        text,
                        h(
                            'div',
                            { className: 'empty' },
                            h(
                                'p',
                                null,
                                canFetch
                                    ? 'the puzzle text has not been downloaded for this puzzle.'
                                    : `the hub cannot download ${source?.provider.name ?? 'this site'}'s puzzle text: read it on the site.`,
                            ),
                            canFetch ? h('button', { className: 'link', onClick: () => fetchText() }, 'fetch puzzle text') : null,
                            ' ',
                            h('button', { className: 'link', onClick: () => setMode('website') }, 'show the website instead'),
                        ),
                    );
                    return;
                }
                renderText(description.markdown, description.parts, description.fetchedAt);
            } catch (error) {
                loadedFor = '';
                replace(text, h('div', { className: 'empty error' }, error instanceof Error ? error.message : String(error)));
            }
        };

        const render = () => {
            const { detail } = getState();
            const source = activeSource();
            const url = detail?.url || source?.provider.home || '';
            link.href = url || '#';
            link.textContent = `open on ${source?.provider.name.toLowerCase() ?? 'site'}`;
            link.style.display = url ? '' : 'none';
            textButton.classList.toggle('current', mode === 'text');
            siteButton.classList.toggle('current', mode === 'website');
            refreshButton.style.display = mode === 'text' && source?.capabilities.fetchDescription ? '' : 'none';
            reloadButton.style.display = mode === 'website' ? '' : 'none';
            if (mode === 'website') {
                if (url && frame.src !== url) frame.src = url;
                setInfo(url);
                replace(body, frame);
            } else {
                replace(body, text);
                loadText();
            }
        };

        const setMode = (next: 'text' | 'website') => {
            mode = next;
            settings.set({ puzzlePanelMode: next });
            render();
        };

        container.append(
            h(
                'div',
                { className: 'panel' },
                h(
                    'div',
                    { className: 'toolbar' },
                    h('span', { className: 'group' }, textButton, siteButton),
                    refreshButton,
                    reloadButton,
                    link,
                    h('span', { className: 'spacer' }),
                    info,
                ),
                body,
            ),
        );

        const unsubscribes = [
            subscribe(render, ['puzzle', 'hub']),
            subscribe(() => {
                // the site url arrives with the detail; a fetch/scaffold may also have produced the text after the first load
                const { detail } = getState();
                if (mode === 'website' || link.href.endsWith('#')) render();
                if (mode === 'text' && detail?.hasDescription && text.querySelector('.empty')) {
                    loadedFor = '';
                    loadText();
                }
            }, ['detail']),
        ];
        render();

        return { dispose: () => unsubscribes.forEach((fn) => fn()) };
    },
};
