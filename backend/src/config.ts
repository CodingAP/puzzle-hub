/**
 * backend/src/config.ts
 *
 * hub wide configuration: where the hub lives, where its private data goes, which sources are mounted
 */

import { fromModule, join, readTextOrNull, resolvePath } from './fs.ts';

/** version reported by the cli banner and /api/health */
export const VERSION = '5.0.0';

export const hubRoot = fromModule(import.meta.url, '../..');
export const backendDir = join(hubRoot, 'backend');
export const frontendDir = join(hubRoot, 'frontend');
export const runnerChildPath = join(backendDir, 'runner-child.ts');

/** private, never committed: credentials (local.json) */
export const dataDir = Deno.env.get('HUB_DATA_DIR') ?? join(hubRoot, 'data');

/** environment driven settings, read lazily so --env-file is always applied first */
export const env = {
    apiToken: () => Deno.env.get('API_TOKEN') || undefined,
    port: () => Number(Deno.env.get('PORT') ?? 8000),
    runTimeoutMs: () => Number(Deno.env.get('RUN_TIMEOUT_MS') ?? 120_000),
    /** v8 heap cap for a solution run; a runaway solution dies with an out-of-memory error instead of taking the machine down */
    runMaxMemoryMb: () => Number(Deno.env.get('RUN_MAX_MEMORY_MB') ?? 2048),
};

export interface HubConfig {
    /** shown in the browser and the cli banner */
    title: string;
    /** sent as the User-Agent of every request a provider makes, so site owners can reach whoever runs this hub */
    contact: string;
    /** absolute paths of the mounted source repositories */
    sources: string[];
}

/**
 * hub.json (path overridable with HUB_CONFIG) next to the hub, with HUB_TITLE / HUB_CONTACT / HUB_SOURCES overrides.
 * source paths are relative to the config file.
 */
export const loadHubConfig = async (): Promise<HubConfig> => {
    const configPath = Deno.env.get('HUB_CONFIG') ?? join(hubRoot, 'hub.json');
    const configDir = configPath.slice(0, configPath.lastIndexOf('/')) || '/';
    let file: Partial<HubConfig> = {};
    const raw = await readTextOrNull(configPath);
    if (raw) {
        try {
            file = JSON.parse(raw);
        } catch (error) {
            throw new Error(`${configPath} is not valid json: ${error instanceof Error ? error.message : error}`);
        }
    }

    const fromEnv = Deno.env.get('HUB_SOURCES');
    const sources = (fromEnv ? fromEnv.split(',') : file.sources ?? []).map((path) => path.trim()).filter(Boolean);

    return {
        title: Deno.env.get('HUB_TITLE') ?? file.title ?? 'Puzzle Hub',
        contact: Deno.env.get('HUB_CONTACT') ?? file.contact ?? 'puzzle-hub (no contact configured)',
        sources: sources.map((path) => resolvePath(configDir, path)),
    };
};

/** a single part number, or every part of the puzzle */
export type PartSpec = number | 'all';

export const parsePartSpec = (value: unknown, parts: number): PartSpec | null => {
    if (value === undefined || value === null || value === '' || value === 'all' || value === 'both') return 'all';
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= parts ? number : null;
};
