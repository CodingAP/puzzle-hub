/**
 * backend/src/providers/aquaq.ts
 *
 * https://challenges.aquaq.co.uk: one-part challenges numbered from 0. the list (with titles) is public, the
 * challenges themselves are behind a login.
 */

import { findElement, type HtmlNode, parseHtml, textOf } from '../html.ts';
import { fetchTimeout, MissingCredentialError, type Provider, type ProviderContext, range, RejectedCredentialError } from './mod.ts';

const BASE = 'https://challenges.aquaq.co.uk';
const GROUP = 'challenges';

const headers = (context: ProviderContext) => ({ cookie: `session=${context.session}`, 'User-Agent': context.userAgent });

// the text and the accepted answer come from the same page: ask for it once
const pages = new Map<string, { at: number; page: Promise<string | null> }>();

/** the challenge page, or null when it is not reachable (it redirects to the login page without a valid cookie) */
const fetchPage = (context: ProviderContext, puzzle: number): Promise<string | null> => {
    if (!context.session) throw new MissingCredentialError(aquaq);
    const key = `${context.session.slice(-12)}/${puzzle}`;
    const cached = pages.get(key);
    if (cached && Date.now() - cached.at < 15_000) return cached.page;
    const page = (async () => {
        const response = await fetch(`${BASE}/challenge/${puzzle}`, { headers: headers(context), signal: fetchTimeout() });
        if (!response.ok || response.url.includes('/login')) return null;
        return await response.text();
    })();
    pages.set(key, { at: Date.now(), page });
    page.catch(() => pages.delete(key));
    return page;
};

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * the challenge text as tidy markup: the site writes prose with <br> line breaks and puts examples in boxes whose
 * <pre> also uses <br> for new lines. examples become real blocks; buttons and forms are left out.
 */
const serialize = (node: HtmlNode, inPre = false): string => {
    if (node.type === 'text') return escapeHtml(node.text);
    const children = (pre = inPre) => node.children.map((child) => serialize(child, pre)).join('');
    switch (node.tag) {
        case 'br':
            return inPre ? '\n' : '<br>';
        case 'pre':
            return `<pre class="block">${children(true).replace(/^\n+|\s+$/g, '')}</pre>`;
        case 'form':
        case 'script':
        case 'style':
        case 'input':
        case 'select':
        case 'button':
            return '';
        case 'a': {
            if (/\bbtn\b/.test(node.attributes.class ?? '')) return ''; // "get input" and friends
            const href = node.attributes.href ?? '';
            return `<a href="${escapeHtml(/^https?:/.test(href) ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`)}">${children()}</a>`;
        }
        case 'div':
            // the example boxes only wrap a <pre>; other wrappers are structure the hub does not need
            return /bd-container-body-mono/.test(node.attributes.class ?? '') ? `<div class="example-box">${children()}</div>` : children();
        default:
            return /^(b|strong|i|em|u|code|ul|ol|li|p|h[1-6]|table|thead|tbody|tr|th|td|sub|sup|span)$/.test(node.tag)
                ? `<${node.tag}>${children()}</${node.tag}>`
                : children();
    }
};

/** every challenge on the public front page as number -> title */
const fetchIndex = async (context: ProviderContext): Promise<Map<number, string>> => {
    const response = await fetch(BASE, { headers: { 'User-Agent': context.userAgent }, signal: fetchTimeout() });
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
        const response = await fetch(`${BASE}/challenge/${puzzle}/input.txt`, { headers: headers(context), signal: fetchTimeout() });
        // without a valid cookie the site redirects to its login page
        if (response.url.includes('/login')) {
            throw new RejectedCredentialError(`could not fetch the input for challenge ${puzzle}: the session cookie is probably expired or wrong`);
        }
        if (!response.ok) {
            throw new Error(
                `could not fetch the input for challenge ${puzzle}: ${response.status} ${response.statusText} (the session cookie is probably expired or wrong)`,
            );
        }
        return { 0: await response.text() };
    },

    async fetchDescription(context, _group, puzzle) {
        const html = await fetchPage(context, puzzle);
        if (!html) return null;
        const body = findElement(
            parseHtml(html),
            (element) => element.tag === 'div' && (element.attributes.class ?? '').split(/\s+/).includes('bd-container-body'),
        );
        if (!body) return null;
        const text = serialize(body)
            .replace(/^(\s|<br>)+|(\s|<br>)+$/g, '') // the page pads the text with blank lines
            .replace(/(<br>\s*)+(<div class="example-box">)/g, '$2') // examples are blocks: no extra blank lines around them
            .replace(/(<\/div>)(\s*<br>)+/g, '$1');
        return text ? { markdown: `<section class="challenge">\n${text}\n</section>\n`, parts: 1, format: 'html' } : null;
    },

    /** a solved challenge shows the answer that was accepted */
    async fetchSolved(context, _group, puzzle) {
        const html = await fetchPage(context, puzzle);
        const answer = html?.match(/already completed this challenge\s*<br\s*\/?>\s*The answer was ([\s\S]*?)\s*<\/div>/i)?.[1];
        const solved: Record<number, string> = {};
        if (answer) solved[1] = textOf(parseHtml(answer)).trim();
        return solved;
    },
};
