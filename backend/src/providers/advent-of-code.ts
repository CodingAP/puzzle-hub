/**
 * backend/src/providers/advent-of-code.ts
 *
 * https://adventofcode.com: years of 25 days (12 from 2025), two parts sharing one input
 */

import { elementChildren, findElement, parseHtml, textOf } from '../html.ts';
import { toMarkdown } from '../htmlmd.ts';
import { MissingCredentialError, type Provider, type ProviderContext, range, type SubmitResult } from './mod.ts';

const BASE = 'https://adventofcode.com';
const FIRST_YEAR = 2015;

/** puzzles unlock at midnight US eastern time (utc-5 all through december), wherever the hub runs */
const eastern = (now: Date) => {
    const shifted = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

/** the latest year that has puzzles: this year once december has started, else last year */
const currentYear = (now: Date): number => {
    const { year, month } = eastern(now);
    return month === 12 ? year : year - 1;
};

/** how long an event runs when the site has not told us yet (see discover) */
const daysInYear = (year: number) => (year >= 2025 ? 12 : 25);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const headers = (context: ProviderContext) => ({
    'Content-Type': 'application/x-www-form-urlencoded',
    cookie: `session=${context.session}`,
    'User-Agent': context.userAgent,
});

const explain = (
    status: number,
) => (status === 400 || status === 401 ? ' (the session cookie is probably expired or wrong)' : status === 404 ? ' (puzzle not released yet)' : '');

const fetchPage = async (context: ProviderContext, group: string, puzzle: number): Promise<{ title: string; html: string } | null> => {
    const response = await fetch(`${BASE}/${group}/day/${puzzle}`, { headers: headers(context) });
    if (!response.ok) return null;
    const html = await response.text();
    const match = html.match(/<h2>--- Day \d+: (.+?) ---<\/h2>/);
    if (!match) return null;
    const title = textOf(parseHtml(match[1])).trim();
    return { title, html };
};

export const adventOfCode: Provider = {
    id: 'advent-of-code',
    name: 'Advent of Code',
    home: BASE,
    labels: { group: 'year', puzzle: 'day' },
    parts: 2,
    perPartInput: false,
    credential: { label: 'session cookie', hint: 'the value of the "session" cookie on adventofcode.com' },

    groups(now = new Date()) {
        const today = eastern(now);
        return range(FIRST_YEAR, currentYear(now)).map((year) => {
            const inProgress = year === today.year && today.month === 12;
            const last = inProgress ? Math.min(daysInYear(year), today.day) : daysInYear(year);
            return { id: String(year), label: String(year), puzzles: range(1, last) };
        });
    },

    /**
     * the public calendar page of each year links every day that exists. finished years never change, so each is
     * read once; only the running event is looked at again (hourly in december).
     */
    async discover(context, now = new Date(), previous) {
        const today = eastern(now);
        const groups = [];
        let fetched = 0;
        for (const year of range(FIRST_YEAR, today.year)) {
            const id = String(year);
            const known = previous?.groups.find((group) => group.id === id);
            if (known && year < today.year) {
                groups.push(known);
                continue;
            }
            if (fetched++ > 0) await sleep(500); // be gentle: this is a dozen requests the first time, one afterwards
            const response = await fetch(`${BASE}/${year}`, { headers: { 'User-Agent': context.userAgent } });
            const html = response.ok ? await response.text() : '';
            const days = [...new Set([...html.matchAll(new RegExp(`href="/${year}/day/(\\d+)"`, 'g'))].map((match) => Number(match[1])))].sort((a, b) => a - b);
            if (days.length) groups.push({ id, label: id, puzzles: days });
            else if (known) groups.push(known);
            else if (year < today.year) groups.push({ id, label: id, puzzles: range(1, daysInYear(year)) });
        }
        return groups.length ? { groups, maxAgeMs: today.month === 12 ? 60 * 60 * 1000 : undefined } : null;
    },

    /** the calendar alone says today's puzzle is out, so it shows up at midnight without waiting for the next look at the site */
    released(now = new Date()) {
        const today = eastern(now);
        if (today.month !== 12) return [];
        const id = String(today.year);
        return [{ id, label: id, puzzles: range(1, Math.min(daysInYear(today.year), today.day)) }];
    },

    puzzleUrl: (group, puzzle) => `${BASE}/${group}/day/${puzzle}`,

    current(now) {
        const today = eastern(now);
        if (today.month !== 12 || today.day > daysInYear(today.year)) return null;
        return { group: String(today.year), puzzle: today.day };
    },

    heading: (group, puzzle, title) => `# Advent of Code ${group} - Day ${puzzle}: [${title}](${BASE}/${group}/day/${puzzle})`,

    async fetchTitle(context, group, puzzle) {
        return (await fetchPage(context, group, puzzle))?.title ?? null;
    },

    async fetchInputs(context, group, puzzle) {
        if (!context.session) throw new MissingCredentialError(adventOfCode);
        const response = await fetch(`${BASE}/${group}/day/${puzzle}/input`, { headers: headers(context) });
        if (!response.ok) {
            throw new Error(`could not fetch input for ${group} day ${puzzle}: ${response.status} ${response.statusText}${explain(response.status)}`);
        }
        return { 0: await response.text() };
    },

    async fetchDescription(context, group, puzzle) {
        const page = await fetchPage(context, group, puzzle);
        if (!page) return null;
        const root = parseHtml(page.html);
        const main = findElement(root, (element) => element.tag === 'main') ?? findElement(root, (element) => element.tag === 'body') ?? root;
        let markdown = '';
        let parts = 0;
        for (const child of elementChildren(main)) {
            if (child.tag === 'article' && (child.attributes.class ?? '').includes('day-desc')) {
                parts++;
                markdown += toMarkdown(child, BASE);
            } else if (child.tag === 'p' && textOf(child).includes('Your puzzle answer was')) {
                markdown += toMarkdown(child, BASE);
            }
        }
        return parts ? { markdown: markdown.trim() + '\n', parts } : null;
    },

    async submit(context, group, puzzle, part, answer): Promise<SubmitResult> {
        if (!context.session) throw new MissingCredentialError(adventOfCode);
        const response = await fetch(`${BASE}/${group}/day/${puzzle}/answer`, {
            method: 'POST',
            headers: headers(context),
            body: new URLSearchParams({ level: String(part), answer }),
        });
        if (!response.ok) throw new Error(`submission failed: ${response.status} ${response.statusText}`);
        const text = await response.text();
        if (text.includes("That's the right answer")) return 'correct';
        if (text.includes("That's not the right answer")) return 'incorrect';
        if (text.includes('You gave an answer too recently')) return 'too-soon';
        if (text.includes("You don't seem to be solving the right level")) return 'already-solved';
        return 'unknown';
    },
};
