/**
 * backend/src/providers/everybody-codes.ts
 *
 * https://everybody.codes: events (by year) and stories, quests with three parts, each part with its own input.
 * titles, puzzle text and inputs are aes encrypted; the keys come from the api once a part is unlocked.
 */

import { parseHtml } from '../html.ts';
import { toMarkdown } from '../htmlmd.ts';
import { MissingCredentialError, type Provider, type ProviderContext, range } from './mod.ts';

const BASE = 'https://everybody.codes';
const CDN = 'https://everybody-codes.b-cdn.net/assets';
const FIRST_EVENT = 2024;
const STORIES = [1, 2, 3];

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

interface Keys {
    key1?: string;
    key2?: string;
    key3?: string;
}

const fetchKeys = async (context: ProviderContext, id: string, puzzle: number): Promise<Keys> => {
    if (!context.session) throw new MissingCredentialError(everybodyCodes);
    const response = await fetch(`${BASE}/api/event/${id}/quest/${puzzle}`, { headers: headers(context) });
    if (!response.ok) throw new Error(`could not fetch keys for quest ${puzzle}: ${response.status} ${response.statusText}`);
    try {
        return await response.json();
    } catch {
        throw new Error('everybody.codes did not return keys (the session cookie is probably expired or wrong)');
    }
};

const fetchJson = async (url: string): Promise<Record<string, string> | null> => {
    const response = await fetch(url);
    if (!response.ok) return null;
    try {
        return await response.json();
    } catch {
        return null;
    }
};

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
        const keys = await fetchKeys(context, id, puzzle);
        const description = await fetchJson(`${CDN}/${id}/${puzzle}/description.json`);
        if (!keys.key1 || !description?.title) return null;
        return (await decrypt(description.title, keys.key1)).trim();
    },

    async fetchInputs(context, group, puzzle) {
        const { id } = parseGroup(group);
        const me = await fetch(`${BASE}/api/user/me`, { headers: headers(context) });
        if (!context.session || !me.ok) throw new MissingCredentialError(everybodyCodes);
        let seed: number;
        try {
            seed = (await me.json()).seed;
        } catch {
            throw new Error('everybody.codes did not return your profile (the session cookie is probably expired or wrong)');
        }
        const keys = await fetchKeys(context, id, puzzle);
        const inputs = await fetchJson(`${CDN}/${id}/${puzzle}/input/${seed}.json`);
        if (!inputs) throw new Error(`no inputs published for quest ${puzzle} of ${group}`);

        const result: Record<number, string> = {};
        for (const part of [1, 2, 3] as const) {
            const key = keys[`key${part}`];
            if (key && inputs[String(part)]) result[part] = await decrypt(inputs[String(part)], key);
        }
        if (!Object.keys(result).length) throw new Error(`no part of quest ${puzzle} is unlocked yet`);
        return result;
    },

    async fetchDescription(context, group, puzzle) {
        const { id } = parseGroup(group);
        const keys = await fetchKeys(context, id, puzzle);
        const description = await fetchJson(`${CDN}/${id}/${puzzle}/description.json`);
        if (!description || !keys.key1) return null;

        let markdown = '';
        let parts = 0;
        for (const part of [1, 2, 3] as const) {
            const key = keys[`key${part}`];
            if (!key || !description[String(part)]) continue;
            const html = await decrypt(description[String(part)], key);
            markdown += `## Part ${part}\n\n${toMarkdown(parseHtml(html), BASE).trim()}\n\n`;
            parts++;
        }
        return parts ? { markdown: markdown.trim() + '\n', parts } : null;
    },
};
