/**
 * backend/src/providers/aquaq.ts
 *
 * https://challenges.aquaq.co.uk: one-part challenges numbered from 0. the list (with titles) is public, the
 * challenges themselves are behind a login.
 */

import { findElement, parseHtml, textOf } from '../html.ts';
import { toMarkdown } from '../htmlmd.ts';
import { MissingCredentialError, type Provider, type ProviderContext, range } from './mod.ts';

const BASE = 'https://challenges.aquaq.co.uk';
const GROUP = 'challenges';

const headers = (context: ProviderContext) => ({ cookie: `session=${context.session}`, 'User-Agent': context.userAgent });

/** the challenge page, or null when it is not reachable (it redirects to the login page without a valid cookie) */
const fetchPage = async (context: ProviderContext, puzzle: number): Promise<string | null> => {
    if (!context.session) throw new MissingCredentialError(aquaq);
    const response = await fetch(`${BASE}/challenge/${puzzle}`, { headers: headers(context) });
    if (!response.ok || response.url.includes('/login')) return null;
    return await response.text();
};

/** every challenge on the public front page as number -> title */
const fetchIndex = async (context: ProviderContext): Promise<Map<number, string>> => {
    const response = await fetch(BASE, { headers: { 'User-Agent': context.userAgent } });
    if (!response.ok) throw new Error(`${BASE} answered ${response.status}`);
    const challenges = new Map<number, string>();
    for (const match of (await response.text()).matchAll(/<a\b[^>]*href="\/challenge\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        challenges.set(Number(match[1]), textOf(parseHtml(match[2])).trim());
    }
    return challenges;
};

export const aquaq: Provider = {
    id: 'aquaq',
    name: 'AquaQ Challenges',
    home: BASE,
    labels: { group: '', puzzle: 'challenge' },
    parts: 1,
    perPartInput: false,
    credential: { label: 'session cookie', hint: 'the value of the "session" cookie on challenges.aquaq.co.uk' },

    groups: () => [{ id: GROUP, label: 'Challenges', puzzles: range(0, 40) }],

    async discover(context) {
        const challenges = await fetchIndex(context);
        if (challenges.size === 0) return null;
        return {
            groups: [{ id: GROUP, label: 'Challenges', puzzles: [...challenges.keys()].sort((a, b) => a - b) }],
            titles: { [GROUP]: Object.fromEntries(challenges) },
        };
    },

    puzzleUrl: (_group, puzzle) => `${BASE}/challenge/${puzzle}`,

    heading: (_group, puzzle, title) => `# AquaQ Challenge ${puzzle}: [${title}](${BASE}/challenge/${puzzle})`,

    async fetchTitle(context, _group, puzzle) {
        return (await fetchIndex(context)).get(puzzle) || null;
    },

    async fetchInputs(context, _group, puzzle) {
        if (!context.session) throw new MissingCredentialError(aquaq);
        const response = await fetch(`${BASE}/challenge/${puzzle}/input.txt`, { headers: headers(context) });
        if (!response.ok || response.url.includes('/login')) {
            throw new Error(
                `could not fetch the input for challenge ${puzzle}: ${response.status} ${response.statusText} (the session cookie is probably expired or wrong)`,
            );
        }
        return { 0: await response.text() };
    },

    async fetchDescription(context, _group, puzzle) {
        const html = await fetchPage(context, puzzle);
        if (!html) return null;
        const root = parseHtml(html);
        const container = findElement(root, (element) => element.tag === 'main') ??
            findElement(root, (element) => element.tag === 'div' && /challenge|content|container/.test(element.attributes.class ?? '')) ??
            findElement(root, (element) => element.tag === 'body');
        if (!container) return null;
        const markdown = toMarkdown(container, BASE).trim();
        return markdown ? { markdown: markdown + '\n', parts: 1 } : null;
    },
};
