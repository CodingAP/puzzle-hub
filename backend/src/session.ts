/**
 * backend/src/session.ts
 *
 * credentials for puzzle sites (session cookies). they expire and get rotated, so they live in a private json file
 * in the hub's data directory that is re-read on every use and can be changed at runtime (cli, api, settings panel).
 * SESSION_<PROVIDER> environment variables are a fallback for containers.
 */

import { dataDir } from './config.ts';
import { ensureDir, join, readTextOrNull } from './fs.ts';

export const LOCAL_CONFIG_PATH = join(dataDir, 'local.json');

interface LocalConfig {
    credentials?: Record<string, { value: string; updated: string }>;
}

export interface CredentialInfo {
    configured: boolean;
    source: 'file' | 'env' | null;
    /** last few characters, enough to recognise which one is active */
    preview: string | null;
    updated: string | null;
}

const readLocal = async (): Promise<LocalConfig> => {
    const raw = await readTextOrNull(LOCAL_CONFIG_PATH);
    if (!raw) return {};
    try {
        return JSON.parse(raw) as LocalConfig;
    } catch {
        return {};
    }
};

const fromEnv = (provider: string): string => {
    const specific = Deno.env.get(`SESSION_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`)?.trim();
    // SESSION alone is the historical name of the advent of code cookie
    return specific || (provider === 'advent-of-code' ? Deno.env.get('SESSION')?.trim() ?? '' : '');
};

/** the active credential for a provider, or '' when none is configured */
export const getCredential = async (provider: string): Promise<string> => {
    const local = await readLocal();
    return local.credentials?.[provider]?.value?.trim() || fromEnv(provider);
};

export const getCredentialInfo = async (provider: string): Promise<CredentialInfo> => {
    const local = await readLocal();
    const stored = local.credentials?.[provider];
    const file = stored?.value?.trim();
    const environment = fromEnv(provider);
    const active = file || environment;
    return {
        configured: !!active,
        source: file ? 'file' : environment ? 'env' : null,
        preview: active ? `…${active.slice(-6)}` : null,
        updated: file ? stored?.updated ?? null : null,
    };
};

/** stores (or with null / '', clears) the credential for a provider */
export const setCredential = async (provider: string, value: string | null): Promise<CredentialInfo> => {
    const local = await readLocal();
    const cleaned = value?.trim().replace(/^[\w-]+=/, '') ?? '';
    local.credentials ??= {};
    if (cleaned) local.credentials[provider] = { value: cleaned, updated: new Date().toISOString() };
    else delete local.credentials[provider];
    await ensureDir(dataDir);
    await Deno.writeTextFile(LOCAL_CONFIG_PATH, JSON.stringify(local, null, 4) + '\n');
    return getCredentialInfo(provider);
};
