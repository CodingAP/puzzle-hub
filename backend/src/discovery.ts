/**
 * backend/src/discovery.ts
 *
 * which groups and puzzles a site currently has. providers that can tell (a public index, a cdn to probe) are asked
 * at most once a day and the answer is cached in the hub's data folder; a provider's built-in list is only the fallback
 * for when the site has never been reachable.
 */

import { dataDir } from './config.ts';
import { getStoredTitle, storeTitle } from './db.ts';
import { ensureDir, join, readTextOrNull } from './fs.ts';
import type { Discovery, GroupInfo } from './providers/mod.ts';
import { providerContext, type Source } from './sources.ts';

const CACHE_PATH = join(dataDir, 'discovered.json');
/** how long an answer is trusted before the site is asked again (in the background) */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** after a failed attempt, leave the site alone for a while */
const RETRY_AFTER_MS = 10 * 60 * 1000;
/** the very first lookup is awaited, but never for long */
const FIRST_LOOKUP_TIMEOUT_MS = 12_000;

interface Entry extends Discovery {
    fetchedAt: string;
}

let cache: Record<string, Entry> | null = null;
const running = new Map<string, Promise<Entry | null>>();
const lastAttempt = new Map<string, number>();
const titlesApplied = new Set<string>();

const load = async (): Promise<Record<string, Entry>> => {
    if (cache) return cache;
    try {
        cache = JSON.parse((await readTextOrNull(CACHE_PATH)) ?? '{}') as Record<string, Entry>;
    } catch {
        cache = {};
    }
    return cache;
};

const valid = (discovery: Discovery | null): discovery is Discovery =>
    !!discovery && Array.isArray(discovery.groups) && discovery.groups.length > 0 && discovery.groups.every((group) => group.puzzles.length > 0);

/** asks the site now; resolves with the new entry, or null when the site could not tell us */
export const refreshDiscovery = (source: Source): Promise<Entry | null> => {
    const provider = source.provider;
    if (!provider.discover) return Promise.resolve(null);
    const active = running.get(provider.id);
    if (active) return active;

    lastAttempt.set(provider.id, Date.now());
    const job = (async () => {
        try {
            const previous = (await load())[provider.id] ?? null;
            const discovery = await provider.discover!(await providerContext(source), new Date(), previous);
            if (!valid(discovery)) return null;
            const entry: Entry = { ...discovery, fetchedAt: new Date().toISOString() };
            (await load())[provider.id] = entry;
            await ensureDir(dataDir);
            await Deno.writeTextFile(CACHE_PATH, JSON.stringify(cache, null, 4) + '\n');
            return entry;
        } catch (error) {
            console.error(`could not ask ${provider.name} what it has published: ${error instanceof Error ? error.message : error}`);
            return null;
        } finally {
            running.delete(provider.id);
        }
    })();
    running.set(provider.id, job);
    return job;
};

/** titles that came with the listing are stored for puzzles that have none yet (once per answer and source) */
const applyTitles = (source: Source, entry: Entry): void => {
    const key = `${source.id}@${entry.fetchedAt}`;
    if (!entry.titles || titlesApplied.has(key)) return;
    titlesApplied.add(key);
    for (const [group, titles] of Object.entries(entry.titles)) {
        for (const [puzzle, title] of Object.entries(titles)) {
            if (title && !getStoredTitle(source, group, Number(puzzle))) storeTitle(source, group, Number(puzzle), title);
        }
    }
};

/**
 * the groups the site says exist, or null when the provider cannot tell (or never could reach its site)
 */
export const discoveredGroups = async (source: Source): Promise<GroupInfo[] | null> => {
    const provider = source.provider;
    if (!provider.discover) return null;
    let entry: Entry | null = (await load())[provider.id] ?? null;
    const recentlyTried = Date.now() - (lastAttempt.get(provider.id) ?? 0) < RETRY_AFTER_MS;

    if (!entry && !recentlyTried) {
        entry = await Promise.race([refreshDiscovery(source), new Promise<null>((resolve) => setTimeout(() => resolve(null), FIRST_LOOKUP_TIMEOUT_MS))]);
    } else if (entry && Date.now() - Date.parse(entry.fetchedAt) > (entry.maxAgeMs ?? MAX_AGE_MS) && !recentlyTried) {
        refreshDiscovery(source); // in the background: this request answers from the cache
    }

    if (!entry) return null;
    applyTitles(source, entry);
    return entry.groups;
};
