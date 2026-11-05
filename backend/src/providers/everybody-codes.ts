/**
 * backend/src/providers/everybody-codes.ts
 *
 * https://everybody.codes: events (by year) and stories, quests with three parts, each part with its own input.
 * titles, puzzle text and inputs are aes encrypted files on the site; the keys (and the answers it has accepted)
 * come from the api once a part is unlocked.
 */

import { parseHtml } from '../html.ts';
import { toMarkdown } from '../htmlmd.ts';
import { type GroupInfo, MissingCredentialError, type Provider, type ProviderContext, range, type SubmitResult } from './mod.ts';

const BASE = 'https://everybody.codes';
const API = 'https://api.everybody.codes';
const ASSETS = `${BASE}/assets`;
const FIRST_EVENT = 2024;
/** what exists when the site cannot be asked (see discover) */
const STORIES = [1, 2, 3, 4];

/** "event2024" -> { kind: 'event', id: '2024' }; "story1" -> { kind: 'story', id: '1' } */
const parseGroup = (group: string): { kind: 'event' | 'story'; id: string } => {
    const match = group.match(/^(event|story)(\d+)$/);
    if (!match) throw new Error(`'${group}' is not an everybody.codes group (expected event<year> or story<number>)`);
    return { kind: match[1] as 'event' | 'story', id: match[2] };
};

const headers = (context: ProviderContext) => ({ Cookie: `everybody-codes=${context.session}`, 'User-Agent': context.userAgent });

const decodeHex = (hex: string): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
};

/** aes-cbc with the key's first 16 characters as the iv */
const decrypt = async (encrypted: string, key: string): Promise<string> => {
    const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), 'AES-CBC', false, ['decrypt']);
    const data = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new TextEncoder().encode(key.substring(0, 16)) }, cryptoKey, decodeHex(encrypted));
    return new TextDecoder().decode(data);
};

/** what the api knows about one quest for the logged in user: a key per unlocked part, the answer per solved part */
interface QuestState {
    key1?: string;
    key2?: string;
    key3?: string;
    answer1?: string;
    answer2?: string;
    answer3?: string;
}

/** an api call that must be logged in; the site answers with a web page instead of json when the cookie is not accepted */
const apiJson = async <T>(context: ProviderContext, path: string, init: RequestInit = {}): Promise<T> => {
    if (!context.session) throw new MissingCredentialError(everybodyCodes);
    const response = await fetch(`${API}/${path}`, { ...init, headers: { ...headers(context), ...(init.headers ?? {}) } });
    const text = await response.text();
    try {
        const parsed = JSON.parse(text);
        if (!response.ok) throw new Error(parsed?.message ?? parsed?.error ?? `${response.status} ${response.statusText}`);
        return parsed as T;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`everybody.codes did not answer ${path} with data (${response.status}): the cookie is probably expired or wrong`);
        }
        throw error;
    }
};

// one quest needs its state for the title, the inputs, the text and the answers: ask once, not four times
const questCache = new Map<string, { at: number; state: Promise<QuestState> }>();
const fetchQuest = (context: ProviderContext, id: string, puzzle: number): Promise<QuestState> => {
    const key = `${context.session.slice(-12)}/${id}/${puzzle}`;
    const cached = questCache.get(key);
    if (cached && Date.now() - cached.at < 15_000) return cached.state;
    const state = apiJson<QuestState>(context, `event/${id}/quest/${puzzle}`);
    questCache.set(key, { at: Date.now(), state });
    state.catch(() => questCache.delete(key));
    return state;
};

// the seed picks which input set an account gets; it never changes
const seeds = new Map<string, number>();
const fetchSeed = async (context: ProviderContext): Promise<number> => {
    const known = seeds.get(context.session);
    if (known !== undefined) return known;
    const { seed } = await apiJson<{ seed?: number }>(context, 'user/me');
    if (typeof seed !== 'number') throw new Error('everybody.codes did not return your profile (the cookie is probably expired or wrong)');
    seeds.set(context.session, seed);
    return seed;
};

/** an encrypted asset file; null when it does not exist (the site serves its web page for unknown paths) */
const fetchAsset = async (context: ProviderContext, path: string): Promise<Record<string, string> | null> => {
    const response = await fetch(`${ASSETS}/${path}`, { headers: { 'User-Agent': context.userAgent } });
    if (!response.ok) return null;
    try {
        return await response.json();
    } catch {
        return null;
    }
};

const parts = [1, 2, 3] as const;

export const everybodyCodes: Provider = {
    id: 'everybody-codes',
    name: 'Everybody Codes',
    home: BASE,
    labels: { group: 'event', puzzle: 'quest' },
    parts: 3,
    perPartInput: true,
    credential: { label: 'session cookie', hint: 'the value of the "everybody-codes" cookie on everybody.codes' },

    groups(now = new Date()) {
        // events open in november
        const lastEvent = now.getMonth() >= 10 ? now.getFullYear() : now.getFullYear() - 1;
        return [
            ...range(FIRST_EVENT, lastEvent).map((year) => ({ id: `event${year}`, label: `Event ${year}`, puzzles: range(1, 20) })),
            ...STORIES.map((story) => ({ id: `story${story}`, label: `Story ${story}`, puzzles: range(1, 3) })),
        ];
    },

    /**
     * the site's own app carries the calendar: every event and story with the moment each quest opens. reading it
     * gives exactly the quests that are out, and when to look again for the next one.
     */
    async discover(context, now = new Date()) {
        const request = { headers: { 'User-Agent': context.userAgent } };
        const page = await (await fetch(BASE, request)).text();
        const script = page.match(/src="\/?(main\.[^"]+\.js)"/)?.[1];
        if (!script) return null;
        const code = await (await fetch(`${BASE}/${script}`, request)).text();

        const events: GroupInfo[] = [];
        const stories: GroupInfo[] = [];
        let next = Infinity;
        // each entry has an image named after it (svg/events2025.svg, svg/stories2.svg) and, later in the same object, its quests
        const images = [...code.matchAll(/image:"svg\/([a-z]+)(\d+)\.svg"/g)];
        const calendars = [...code.matchAll(/quests:\{([^}]*)\}/g)];
        for (const [index, calendar] of calendars.entries()) {
            const previous = index > 0 ? calendars[index - 1].index! : -1;
            const image = images.findLast((candidate) => candidate.index! < calendar.index! && candidate.index! > previous);
            if (!image || (image[1] !== 'events' && image[1] !== 'stories')) continue;
            const match = [calendar[0], image[1], image[2], calendar[1]];
            const released: number[] = [];
            for (const [, quest, opens] of match[3].matchAll(/(\d+):([\d.e]+)/g)) {
                const time = Number(opens);
                if (time <= now.getTime()) released.push(Number(quest));
                else next = Math.min(next, time);
            }
            if (!released.length) continue;
            const event = match[1] === 'events';
            (event ? events : stories).push({
                id: `${event ? 'event' : 'story'}${match[2]}`,
                label: `${event ? 'Event' : 'Story'} ${match[2]}`,
                puzzles: released.sort((a, b) => a - b),
            });
        }
        const order = (a: GroupInfo, b: GroupInfo) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, ''));
        const groups = [...events.sort(order), ...stories.sort(order)];
        if (!groups.length) return null;
        // look again a minute after the next quest opens (never more often than every five minutes)
        const untilNext = next - now.getTime() + 60_000;
        return { groups, maxAgeMs: Number.isFinite(untilNext) ? Math.max(5 * 60_000, Math.min(untilNext, 24 * 60 * 60_000)) : undefined };
    },

    puzzleUrl(group, puzzle) {
        const { kind, id } = parseGroup(group);
        return `${BASE}/${kind}/${id}/quests/${puzzle}`;
    },

    heading(group, puzzle, title) {
        const { kind, id } = parseGroup(group);
        return `# Everybody Codes ${kind === 'event' ? 'Event' : 'Story'} ${id} - Quest ${puzzle}: [${title}](${BASE}/${kind}/${id}/quests/${puzzle})`;
    },

    async fetchTitle(context, group, puzzle) {
        const { id } = parseGroup(group);
        const quest = await fetchQuest(context, id, puzzle);
        const description = await fetchAsset(context, `${id}/${puzzle}/description.json`);
        if (!quest.key1 || !description?.title) return null;
        return (await decrypt(description.title, quest.key1)).trim();
    },

    async fetchInputs(context, group, puzzle) {
        const { id } = parseGroup(group);
        const seed = await fetchSeed(context);
        const quest = await fetchQuest(context, id, puzzle);
        const inputs = await fetchAsset(context, `${id}/${puzzle}/input/${seed}.json`);
        if (!inputs) throw new Error(`no inputs published for quest ${puzzle} of ${group}`);

        const result: Record<number, string> = {};
        for (const part of parts) {
            const key = quest[`key${part}`];
            if (key && inputs[String(part)]) result[part] = await decrypt(inputs[String(part)], key);
        }
        if (!Object.keys(result).length) throw new Error(`no part of quest ${puzzle} is unlocked for you yet (it opens on the site first)`);
        return result;
    },

    async fetchDescription(context, group, puzzle) {
        const { id } = parseGroup(group);
        const quest = await fetchQuest(context, id, puzzle);
        const description = await fetchAsset(context, `${id}/${puzzle}/description.json`);
        if (!description || !quest.key1) return null;

        let markdown = '';
        let count = 0;
        for (const part of parts) {
            const key = quest[`key${part}`];
            if (!key || !description[String(part)]) continue;
            const html = await decrypt(description[String(part)], key);
            markdown += `## Part ${part}\n\n${toMarkdown(parseHtml(html), BASE).trim()}\n\n`;
            count++;
        }
        return count ? { markdown: markdown.trim() + '\n', parts: count } : null;
    },

    /** the answers the site has already accepted for this account */
    async fetchSolved(context, group, puzzle) {
        const { id } = parseGroup(group);
        const quest = await fetchQuest(context, id, puzzle);
        const solved: Record<number, string> = {};
        for (const part of parts) {
            const answer = quest[`answer${part}`];
            if (answer !== undefined && answer !== null && String(answer) !== '') solved[part] = String(answer);
        }
        return solved;
    },

    async submit(context, group, puzzle, part, answer): Promise<SubmitResult> {
        const { id } = parseGroup(group);
        // a part the site already holds an answer for is settled without submitting again
        const accepted = (await fetchQuest(context, id, puzzle))[`answer${part}` as keyof QuestState];
        if (accepted !== undefined && accepted !== null && String(accepted) !== '') return String(accepted) === answer ? 'correct' : 'already-solved';

        let verdict: { correct?: boolean; penaltyLeftMs?: number };
        try {
            verdict = await apiJson(context, `event/${id}/quest/${puzzle}/part/${part}/answer`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ answer }),
            });
        } catch (error) {
            if (error instanceof MissingCredentialError) throw error;
            return 'unknown';
        }
        questCache.clear(); // the next look at the quest should see the new part
        if (verdict.correct === true) return 'correct';
        if (verdict.correct === false) return 'incorrect';
        return (verdict.penaltyLeftMs ?? 0) > 0 ? 'too-soon' : 'unknown';
    },
};
