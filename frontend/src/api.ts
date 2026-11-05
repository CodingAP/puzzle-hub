/**
 * frontend/src/api.ts
 *
 * thin fetch wrapper for the backend json api
 */

import { settings } from './settings.ts';
import type {
    BulkOptions,
    BulkStatus,
    CredentialInfo,
    Description,
    Example,
    GroupSummary,
    Health,
    Hub,
    Part,
    PuzzleDetail,
    PuzzleRef,
    PuzzleSummary,
    RunHandlers,
    RunOutcome,
    RunRequest,
    SubmitOutcome,
} from './types.ts';

export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = 'ApiError';
    }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** called whenever the api rejects the current token */
export const onUnauthorized = (listener: UnauthorizedListener) => {
    unauthorizedListeners.add(listener);
    return () => unauthorizedListeners.delete(listener);
};

const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const { apiBase, token } = settings.get();
    const headers = new Headers(init.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (init.body) headers.set('content-type', 'application/json');

    const response = await fetch(`${apiBase.replace(/\/$/, '')}${path}`, { ...init, headers });

    if (response.status === 401) {
        for (const listener of unauthorizedListeners) listener();
        throw new ApiError(401, 'unauthorized: set your api token in settings');
    }

    if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
            const body = await response.json();
            if (body?.error) message = body.error;
        } catch {
            // not json, keep the status text
        }
        throw new ApiError(response.status, message);
    }

    return response;
};

const getJson = async <T>(path: string): Promise<T> => (await request(path)).json();
const getText = async (path: string): Promise<string> => (await request(path)).text();
const send = async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
    (await request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), signal })).json();

const sourcePath = (source: string) => `/api/sources/${encodeURIComponent(source)}`;
const puzzle = (ref: PuzzleRef) => `${sourcePath(ref.source)}/puzzles/${encodeURIComponent(ref.group)}/${ref.puzzle}`;

/** resolves with null instead of throwing when the thing simply does not exist yet */
const orNull = async <T>(promise: Promise<T>): Promise<T | null> => {
    try {
        return await promise;
    } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
    }
};

export const api = {
    health: () => getJson<Health>('/api/health'),
    hub: () => getJson<Hub>('/api/hub'),
    setCredential: (source: string, value: string) => send<CredentialInfo>('PUT', `${sourcePath(source)}/credential`, { value }),
    groups: (source: string) => getJson<GroupSummary[]>(`${sourcePath(source)}/groups`),
    group: (source: string, group: string) => getJson<PuzzleSummary[]>(`${sourcePath(source)}/groups/${encodeURIComponent(group)}`),
    detail: (ref: PuzzleRef) => getJson<PuzzleDetail>(puzzle(ref)),
    solution: (ref: PuzzleRef) => orNull(getJson<{ code: string; file: string }>(`${puzzle(ref)}/solution`)),
    saveSolution: (ref: PuzzleRef, code: string) => send<{ ok: true }>('PUT', `${puzzle(ref)}/solution`, { code }),
    input: (ref: PuzzleRef, part = 1) => orNull(getText(`${puzzle(ref)}/input?part=${part}`)),
    saveInput: (ref: PuzzleRef, part: number, content: string) => send<{ ok: true }>('PUT', `${puzzle(ref)}/input`, { part, content }),
    description: (ref: PuzzleRef) => orNull(getJson<Description>(`${puzzle(ref)}/description`)),
    refreshDescription: (ref: PuzzleRef) => send<Description>('POST', `${puzzle(ref)}/description`),
    bulkStatus: () => getJson<BulkStatus>('/api/bulk'),
    bulkStart: (source: string, options: Partial<BulkOptions>) => send<BulkStatus>('POST', '/api/bulk', { source, ...options }),
    saveReadme: (ref: PuzzleRef, content: string) => send<{ ok: true }>('PUT', `${puzzle(ref)}/readme`, { content }),
    fetch: (ref: PuzzleRef, inputOnly = false) =>
        send<{ ok: true; createdSolution: boolean; inputError: string | null }>('POST', `${puzzle(ref)}/fetch`, { inputOnly }),
    examples: (ref: PuzzleRef) => getJson<Example[]>(`${puzzle(ref)}/examples`),
    saveExamples: (ref: PuzzleRef, examples: Example[]) => send<Example[]>('PUT', `${puzzle(ref)}/examples`, { examples }),
    run: (ref: PuzzleRef, options: RunRequest, signal?: AbortSignal) => send<RunOutcome>('POST', `${puzzle(ref)}/run`, options, signal),
    /** streaming run: console lines arrive through handlers as they happen; resolves with the final outcome */
    runStream: async (ref: PuzzleRef, options: RunRequest, handlers: RunHandlers, signal?: AbortSignal): Promise<RunOutcome> => {
        const response = await request(`${puzzle(ref)}/run`, { method: 'POST', body: JSON.stringify({ ...options, stream: true }), signal });
        if (!response.body) throw new ApiError(500, 'no response body');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let outcome: RunOutcome | null = null;
        let failure: string | null = null;

        const handle = (event: string, data: string) => {
            const payload = data ? JSON.parse(data) : {};
            if (event === 'log') handlers.onLog?.(payload.line);
            else if (event === 'inspector') handlers.onInspector?.(payload);
            else if (event === 'start') handlers.onStart?.();
            else if (event === 'result') outcome = payload;
            else if (event === 'error') failure = payload.message;
        };

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let index: number;
                while ((index = buffer.indexOf('\n\n')) !== -1) {
                    const chunk = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);
                    let event = 'message';
                    const data: string[] = [];
                    for (const line of chunk.split('\n')) {
                        if (line.startsWith('event:')) event = line.slice(6).trim();
                        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
                    }
                    handle(event, data.join('\n'));
                }
            }
        } catch (error) {
            // firefox reports an abruptly closed body as "Error in input stream"; once the result is here that is harmless
            if (!outcome) {
                if (error instanceof DOMException && error.name === 'AbortError') throw error;
                throw new ApiError(
                    0,
                    `lost the connection to the server mid-run (${error instanceof Error ? error.message : String(error)}); it may have restarted`,
                );
            }
        }
        if (failure) throw new ApiError(500, failure);
        if (!outcome) throw new ApiError(500, 'the run ended without a result');
        return outcome;
    },
    submit: (ref: PuzzleRef, options: { part: Part; record: boolean }) => send<SubmitOutcome>('POST', `${puzzle(ref)}/submit`, options),
};
