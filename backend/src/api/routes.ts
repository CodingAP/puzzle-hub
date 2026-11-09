/**
 * backend/src/api/routes.ts
 *
 * the json api used by the frontend (and anything else that wants to drive the hub remotely).
 * every puzzle is addressed as source / group / puzzle.
 */

import { getBulkStatus, startBulkDownload } from '../bulk.ts';
import { parsePartSpec, VERSION } from '../config.ts';
import { getDebugSession, proxyInspector } from '../debug.ts';
import { readExamples, sanitizeExamples, writeExamples } from '../examples.ts';
import { MissingCredentialError } from '../providers/mod.ts';
import {
    fetchDescription,
    getPuzzleDetail,
    listGroup,
    listGroups,
    PuzzleNotGeneratedError,
    readDescription,
    readInput,
    readReadme,
    readSolution,
    scaffoldPuzzle,
    updateInputs,
    writeInput,
    writeReadme,
    writeSolution,
} from '../puzzles.ts';
import { runPuzzle } from '../runner.ts';
import { getCredentialInfo, setCredential } from '../session.ts';
import { assertPuzzle, getHubConfig, getSource, loadSources, puzzlePaths, type Source, SourceError } from '../sources.ts';
import { submitAnswer } from '../submit.ts';
import { authEnabled } from './auth.ts';
import { HttpError, json, type Params, readJson, Router, text } from './router.ts';

const PUZZLE = '/api/sources/:source/puzzles/:group/:puzzle';

/** the folder of a puzzle relative to its repository, and its page there (HEAD follows the default branch, whatever it is called) */
const puzzleLocation = (source: Source, group: string, puzzle: number): { path: string; repositoryUrl: string | null } => {
    const path = puzzlePaths(source, group, puzzle).directory.slice(source.root.length + 1);
    return { path, repositoryUrl: source.repository ? `${source.repository}/tree/HEAD/${path}` : null };
};

const parsePuzzle = async (params: Params): Promise<{ source: Source; group: string; puzzle: number }> => {
    const source = await getSource(params.source);
    const puzzle = Number(params.puzzle);
    await assertPuzzle(source, params.group, puzzle);
    return { source, group: params.group, puzzle };
};

const optionalNumber = (value: unknown, name: string): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new HttpError(400, `${name} must be a positive number`);
    return number;
};

const parsePart = (source: Source, value: unknown) => {
    const part = parsePartSpec(value, source.parts);
    if (part === null) throw new HttpError(400, `part must be 'all' or 1-${source.parts}`);
    return part;
};

const describeSource = async (source: Source) => ({
    id: source.id,
    name: source.name,
    provider: { id: source.provider.id, name: source.provider.name, home: source.provider.home },
    labels: source.labels,
    parts: source.parts,
    perPartInput: source.perPartInput,
    repository: source.repository,
    language: source.layout.solution.split('.').pop() ?? '',
    solutionFile: source.layout.solution,
    capabilities: {
        fetchInputs: !!source.provider.fetchInputs,
        fetchDescription: !!source.provider.fetchDescription,
        submit: !!source.provider.submit,
        debug: source.runner.kind === 'module',
    },
    credential: source.provider.credential ? { ...source.provider.credential, ...(await getCredentialInfo(source.provider.id)) } : null,
});

export const createApiRouter = (): Router => {
    const router = new Router();

    router.get('/api/health', () => json({ ok: true, version: VERSION, auth: authEnabled() }));

    router.get('/api/hub', async () => {
        const config = await getHubConfig();
        const sources = await loadSources();
        return json({ title: config.title, version: VERSION, sources: await Promise.all(sources.map(describeSource)) });
    });

    router.get('/api/sources/:source/groups', async (_request, params) => json(await listGroups(await getSource(params.source))));

    router.get('/api/sources/:source/groups/:group', async (_request, params) => {
        const source = await getSource(params.source);
        const puzzles = await listGroup(source, params.group);
        return json(puzzles.map((puzzle) => ({ ...puzzle, ...puzzleLocation(source, params.group, puzzle.puzzle) })));
    });

    router.get('/api/sources/:source/credential', async (_request, params) => {
        const source = await getSource(params.source);
        return json(await getCredentialInfo(source.provider.id));
    });

    // stores the site credential (empty string clears it); the value itself is never returned
    router.put('/api/sources/:source/credential', async (request, params) => {
        const source = await getSource(params.source);
        const body = await readJson<{ value?: unknown }>(request);
        if (typeof body.value !== 'string') throw new HttpError(400, 'body must be { value: string }');
        return json(await setCredential(source.provider.id, body.value));
    });

    router.get(PUZZLE, async (_request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const detail = await getPuzzleDetail(source, group, puzzle);
        return json({ ...detail, ...puzzleLocation(source, group, puzzle) });
    });

    router.post(`${PUZZLE}/fetch`, async (request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const body = await readJson<{ inputOnly?: boolean }>(request);
        if (body.inputOnly) {
            await updateInputs(source, group, puzzle);
            return json({ ok: true, createdSolution: false, inputError: null });
        }
        const result = await scaffoldPuzzle(source, group, puzzle);
        return json({ ok: true, createdSolution: result.createdSolution, inputError: result.inputError });
    });

    router.get(`${PUZZLE}/solution`, async (_request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const code = await readSolution(source, group, puzzle);
        if (code === null) throw new HttpError(404, 'this puzzle has no solution file yet');
        return json({ code, file: source.layout.solution });
    });

    router.put(`${PUZZLE}/solution`, async (request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const body = await readJson<{ code?: unknown }>(request);
        if (typeof body.code !== 'string') throw new HttpError(400, 'body must be { code: string }');
        await writeSolution(source, group, puzzle, body.code);
        return json({ ok: true });
    });

    router.get(`${PUZZLE}/input`, async (request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const part = Number(new URL(request.url).searchParams.get('part') ?? 1);
        const input = await readInput(source, group, puzzle, Number.isInteger(part) && part >= 1 ? part : 1);
        if (input === null) throw new HttpError(404, 'no input file for this puzzle');
        return text(input);
    });

    // paste an input by hand (sites the hub cannot download from, or a fresh copy)
    router.put(`${PUZZLE}/input`, async (request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const body = await readJson<{ part?: unknown; content?: unknown }>(request);
        if (typeof body.content !== 'string') throw new HttpError(400, 'body must be { content: string, part?: number }');
        const part = Number(body.part ?? 1);
        if (!Number.isInteger(part) || part < 1 || part > source.parts) throw new HttpError(400, `part must be 1-${source.parts}`);
        await writeInput(source, group, puzzle, part, body.content);
        return json({ ok: true });
    });

    router.get(`${PUZZLE}/readme`, async (_request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const readme = await readReadme(source, group, puzzle);
        if (readme === null) throw new HttpError(404, 'no readme for this puzzle');
        return text(readme);
    });

    router.put(`${PUZZLE}/readme`, async (request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const body = await readJson<{ content?: unknown }>(request);
        if (typeof body.content !== 'string') throw new HttpError(400, 'body must be { content: string }');
        await writeReadme(source, group, puzzle, body.content);
        return json({ ok: true });
    });

    router.get(`${PUZZLE}/description`, async (_request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const description = await readDescription(source, group, puzzle);
        if (description === null) throw new HttpError(404, 'puzzle text has not been fetched yet');
        return json(description);
    });

    // (re)downloads the puzzle text, e.g. to pick up the next part after solving one
    router.post(`${PUZZLE}/description`, async (_request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        if (!source.provider.fetchDescription) throw new HttpError(400, `${source.provider.name} puzzle text cannot be downloaded`);
        const description = await fetchDescription(source, group, puzzle);
        if (description === null) throw new HttpError(404, 'the site has no text for this puzzle (yet), or the credential is missing');
        return json(description);
    });

    router.get(`${PUZZLE}/examples`, async (_request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        return json(await readExamples(source, group, puzzle));
    });

    router.put(`${PUZZLE}/examples`, async (request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const body = await readJson<{ examples?: unknown }>(request);
        let examples;
        try {
            examples = sanitizeExamples(body.examples, source.parts);
        } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        await writeExamples(source, group, puzzle, examples);
        return json(examples);
    });

    // { stream: true } answers with server-sent events: start, log (per console line), inspector (debug runs), result | error
    router.post(`${PUZZLE}/run`, async (request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const body = await readJson<
            {
                part?: unknown;
                iterations?: unknown;
                updateReadme?: unknown;
                timeoutMs?: unknown;
                input?: unknown;
                stream?: unknown;
                debug?: unknown;
                commit?: unknown;
            }
        >(request);
        const part = parsePart(source, body.part);
        if (body.input !== undefined && typeof body.input !== 'string') throw new HttpError(400, 'input must be a string');
        if (typeof body.input === 'string' && body.input.length > 1_000_000) throw new HttpError(400, 'input is too large');
        const debug = body.debug === true;
        if (debug && getDebugSession()) throw new HttpError(409, 'a debug session is already running; finish or cancel it first');

        const options = {
            part,
            iterations: optionalNumber(body.iterations, 'iterations'),
            timeoutMs: optionalNumber(body.timeoutMs, 'timeoutMs'),
            updateReadme: body.updateReadme === true,
            input: typeof body.input === 'string' ? body.input : undefined,
            debug,
            commit: body.commit === true,
        };

        if (body.stream !== true) return json(await runPuzzle(source, group, puzzle, options));

        const encoder = new TextEncoder();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
        const send = (event: string, data: unknown) => {
            try {
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch {
                // client went away
            }
        };
        const abort = new AbortController();
        request.signal.addEventListener('abort', () => abort.abort(), { once: true });

        (async () => {
            try {
                send('start', { source: source.id, group, puzzle, part, debug });
                const outcome = await runPuzzle(source, group, puzzle, options, {
                    signal: abort.signal,
                    onLog: (line) => send('log', { line }),
                    onInspector: (info) => send('inspector', info),
                });
                send('result', outcome);
            } catch (error) {
                send('error', { message: error instanceof Error ? error.message : String(error) });
            } finally {
                try {
                    controller.close();
                } catch {
                    // already closed
                }
            }
        })();

        return new Response(stream, {
            headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
        });
    });

    // record: true stores the answers as correct without contacting the site
    router.post(`${PUZZLE}/submit`, async (request, params) => {
        const { source, group, puzzle } = await parsePuzzle(params);
        const body = await readJson<{ part?: unknown; record?: unknown; fake?: unknown }>(request);
        return json(await submitAnswer(source, group, puzzle, parsePart(source, body.part), body.record === true || body.fake === true));
    });

    router.get('/api/bulk', () => json(getBulkStatus()));

    // starts a background download of inputs and/or puzzle text for every published puzzle of a source
    router.post('/api/bulk', async (request) => {
        const body = await readJson<{ source?: unknown; onlyMissing?: unknown; inputs?: unknown; descriptions?: unknown }>(request);
        if (typeof body.source !== 'string') throw new HttpError(400, 'body must name a source');
        const source = await getSource(body.source);
        const started = startBulkDownload(source, {
            onlyMissing: body.onlyMissing !== false,
            inputs: body.inputs !== false,
            descriptions: body.descriptions !== false,
        });
        if (!started) throw new HttpError(409, 'a bulk download is already running');
        return json(getBulkStatus(), 202);
    });

    router.get('/api/debug', () => {
        const session = getDebugSession();
        return json(
            session ? { active: true, source: session.source, group: session.group, puzzle: session.puzzle, startedAt: session.startedAt } : { active: false },
        );
    });

    // chrome devtools (or the hub's own debugger panel) attaches here; the token in the path is the credential
    router.get('/api/debug/ws/:token', (request, params) => proxyInspector(request, params.token));

    return router;
};

/**
 * turns thrown errors into json responses
 */
export const errorResponse = (error: unknown): Response => {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof SourceError) return json({ error: error.message }, error.status);
    if (error instanceof PuzzleNotGeneratedError) return json({ error: error.message }, 404);
    if (error instanceof MissingCredentialError) return json({ error: error.message }, 400);
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'internal error' }, 500);
};
