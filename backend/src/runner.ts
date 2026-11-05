/**
 * backend/src/runner.ts
 *
 * runs and times puzzle solutions in an isolated subprocess, streaming their console output, and records the results.
 * module sources (ts/js) run inside a sandboxed deno child that calls their exports; command sources run any program
 * that prints the answer.
 */

import { env, hubRoot, type PartSpec, runnerChildPath } from './config.ts';
import { insertRun } from './db.ts';
import { clearDebugSession, DEBUG_PORT, disconnectDebugSession, newDebugToken, registerDebugSession } from './debug.ts';
import { exists, join } from './fs.ts';
import { type GitOutcome, publishPuzzle } from './git.ts';
import { getPuzzleStatus, getTitle, PuzzleNotGeneratedError, readReadme, writeReadme } from './puzzles.ts';
import { renderReadme } from './readme.ts';
import { puzzlePaths, type Source } from './sources.ts';

export interface PartResult {
    answer: string;
    timeMs: number;
}

/** keyed part1, part2, … */
export type RunResults = Record<string, PartResult>;

export interface RunOutcome {
    success: boolean;
    error?: string;
    results: RunResults;
    /** the last LOG_KEEP_LINES of console output; everything is streamed live through onLog */
    logs: string;
    logLines: number;
    durationMs: number;
    iterations: number;
    readmeUpdated: boolean;
    cancelled: boolean;
    /** set when the run also committed/pushed the puzzle (profile with commit: true) */
    git?: GitOutcome;
}

export interface RunOptions {
    part?: PartSpec;
    iterations?: number;
    timeoutMs?: number;
    updateReadme?: boolean;
    record?: boolean;
    /** run against this text instead of the input files (example runs are never recorded and never touch the readme) */
    input?: string;
    /** start under the inspector, paused at the first line; no timeout applies (module sources only) */
    debug?: boolean;
    /** after a successful profile (updateReadme), commit the puzzle and push it */
    commit?: boolean;
}

export interface RunHandlers {
    onLog?: (line: string) => void;
    /** fires once the inspector is listening: the token selects the websocket proxy path /api/debug/ws/<token> */
    onInspector?: (info: { token: string }) => void;
    /** aborting kills the child (used when the browser cancels or disconnects) */
    signal?: AbortSignal;
}

/** how much console output is kept for the recorded outcome; the live stream carries all of it */
const LOG_KEEP_LINES = 2000;

/** a debugging session is interactive; still, don't let a forgotten one live forever */
const DEBUG_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const INSPECTOR_NOISE = /^(Debugger listening on |Visit chrome:\/\/inspect|Deno is waiting for debugger|Debugger session (started|ended)|Debugger attached)/;

/**
 * caps a requested timeout to the server configured maximum
 */
export const clampTimeout = (requested?: number): number => {
    const max = env.runTimeoutMs();
    if (!requested || !Number.isFinite(requested) || requested <= 0) return max;
    return Math.min(requested, max);
};

/**
 * reads a byte stream line by line
 */
const readLines = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) !== -1) {
            onLine(buffer.slice(0, index).replace(/\r$/, ''));
            buffer = buffer.slice(index + 1);
        }
    }
    buffer += decoder.decode();
    if (buffer) onLine(buffer);
};

/** the deno config of a source, so its import map applies to its solutions */
const sourceConfig = async (source: Source): Promise<string | null> => {
    for (const name of ['deno.json', 'deno.jsonc']) {
        if (await exists(join(source.root, name))) return join(source.root, name);
    }
    return null;
};

interface Child {
    process: Deno.ChildProcess;
    /** resolves with the results the child reported, if it speaks the json protocol */
    parse(stdout: string): { results?: RunResults; error?: string };
}

/**
 * runs the solution for a puzzle in a subprocess with a timeout, streaming its console output
 */
export const runPuzzle = async (source: Source, group: string, puzzle: number, options: RunOptions = {}, handlers: RunHandlers = {}): Promise<RunOutcome> => {
    const iterations = Math.max(1, Math.floor(options.iterations ?? 1));
    const debug = options.debug === true;
    if (debug && source.runner.kind !== 'module') throw new Error('the debugger only works with typescript/javascript (module) sources');
    const timeoutMs = debug ? DEBUG_TIMEOUT_MS : clampTimeout(options.timeoutMs);
    const customInput = options.input !== undefined;
    const record = !customInput && !debug && (options.record ?? true);

    const paths = puzzlePaths(source, group, puzzle);
    const status = await getPuzzleStatus(source, group, puzzle);
    if (!status.hasSolution) throw new PuzzleNotGeneratedError(source, group, puzzle);

    const requested = options.part ?? 'all';
    const wanted = requested === 'all' ? Array.from({ length: source.parts }, (_, index) => index + 1) : [requested];

    // the child may only read inside the source, so custom input goes into a temporary file next to the solution
    let customPath: string | null = null;
    if (customInput) {
        customPath = await Deno.makeTempFile({ dir: paths.directory, prefix: '.run-', suffix: '.txt' });
        await Deno.writeTextFile(customPath, options.input ?? '');
    }

    // parts whose input has not been downloaded (or unlocked) yet are skipped when running everything
    const skipped: number[] = [];
    const parts: { part: number; input: string }[] = [];
    for (const part of wanted) {
        const input = customPath ?? paths.input(part);
        if (!customPath && !(await exists(input))) {
            skipped.push(part);
            continue;
        }
        parts.push({ part, input });
    }
    if (!parts.length) {
        if (customPath) await Deno.remove(customPath).catch(() => {});
        throw new Error(`no input for ${source.name} ${group} ${source.labels.puzzle} ${puzzle}: fetch it, or paste it into the input panel`);
    }

    const kept: string[] = [];
    let logLines = 0;
    const log = (line: string) => {
        logLines++;
        kept.push(line);
        if (kept.length > LOG_KEEP_LINES) kept.shift();
        handlers.onLog?.(line);
    };
    for (const part of skipped) log(`— part ${part} skipped: no input file yet —`);

    const debugToken = debug ? newDebugToken() : null;
    const started = performance.now();
    let timedOut = false;
    let cancelled = false;
    let current: Deno.ChildProcess | null = null;
    const kill = () => {
        try {
            current?.kill('SIGKILL');
        } catch {
            // already gone
        }
    };
    const timer = setTimeout(() => {
        timedOut = true;
        kill();
    }, timeoutMs);
    const onAbort = () => {
        cancelled = true;
        kill();
    };
    handlers.signal?.addEventListener('abort', onAbort, { once: true });

    const onLine = (line: string) => {
        if (debug) {
            const listening = line.match(/Debugger listening on (ws:\/\/\S+)/);
            if (listening && debugToken) {
                registerDebugSession({ token: debugToken, wsUrl: listening[1], source: source.id, group, puzzle, startedAt: new Date().toISOString() });
                handlers.onInspector?.({ token: debugToken });
                return;
            }
            if (/^Waiting for the debugger to disconnect/.test(line)) {
                // the solution is done; let go of the attached debugger so the child can exit
                if (debugToken) disconnectDebugSession(debugToken);
                return;
            }
            if (INSPECTOR_NOISE.test(line)) return;
        }
        log(line);
    };

    const results: RunResults = {};
    let failure: string | undefined;
    let exitOk = true;

    try {
        if (source.runner.kind === 'module') {
            const pattern = source.runner.exports ?? 'part{part}';
            const config = await sourceConfig(source);
            const spec = {
                solution: paths.solution,
                iterations,
                parts: parts.map(({ part, input }) => ({ part, input, export: pattern.replace('{part}', String(part)) })),
            };
            current = new Deno.Command(Deno.execPath(), {
                args: [
                    'run',
                    // --quiet would also silence the "Debugger listening on" line we need
                    ...(debug ? [] : ['--quiet']),
                    '--no-prompt',
                    `--v8-flags=--max-old-space-size=${env.runMaxMemoryMb()}`,
                    `--allow-read=${source.root},${hubRoot}`,
                    config ? `--config=${config}` : '--no-config',
                    ...(debug ? [`--inspect-brk=127.0.0.1:${DEBUG_PORT}`] : []),
                    runnerChildPath,
                    JSON.stringify(spec),
                ],
                cwd: source.root,
                stdin: 'null',
                stdout: 'piped',
                stderr: 'piped',
            }).spawn();
            const [, stdout] = await Promise.all([readLines(current.stderr, onLine), new Response(current.stdout).text()]);
            exitOk = (await current.status).success;
            const lastLine = stdout.trim().split('\n').at(-1);
            if (lastLine) {
                try {
                    const parsed = JSON.parse(lastLine) as { results?: RunResults; error?: string };
                    Object.assign(results, parsed.results ?? {});
                    failure = parsed.error;
                } catch {
                    // not our protocol: leave results empty
                }
            }
        } else {
            // any language: run the configured command once per part and iteration; its last line of stdout is the answer
            for (const { part, input } of parts) {
                let answer = '';
                let total = 0;
                for (let i = 0; i < iterations && !timedOut && !cancelled && exitOk; i++) {
                    const argv = source.runner.command!.map((arg) =>
                        arg.replaceAll('{solution}', paths.solution).replaceAll('{input}', input).replaceAll('{part}', String(part)).replaceAll(
                            '{dir}',
                            paths.directory,
                        )
                    );
                    const begin = performance.now();
                    current = new Deno.Command(argv[0], { args: argv.slice(1), cwd: paths.directory, stdin: 'null', stdout: 'piped', stderr: 'piped' }).spawn();
                    const [, stdout] = await Promise.all([readLines(current.stderr, onLine), new Response(current.stdout).text()]);
                    exitOk = (await current.status).success;
                    total += performance.now() - begin;
                    const lines = stdout.trimEnd().split('\n');
                    answer = lines.pop() ?? '';
                    for (const line of lines) log(line); // everything before the answer is ordinary output
                }
                if (!exitOk || timedOut || cancelled) break;
                results[`part${part}`] = { answer: answer.trim(), timeMs: total / iterations };
            }
        }
    } catch (error) {
        exitOk = false;
        failure = error instanceof Deno.errors.NotFound
            ? `could not start the runner: ${error.message}`
            : error instanceof Error
            ? error.message
            : String(error);
    } finally {
        clearTimeout(timer);
        handlers.signal?.removeEventListener('abort', onAbort);
        if (debugToken) clearDebugSession(debugToken);
        if (customPath) await Deno.remove(customPath).catch(() => {});
    }
    const durationMs = performance.now() - started;

    const logs = (logLines > kept.length ? `… ${logLines - kept.length} earlier lines omitted …\n` : '') + kept.join('\n');
    const complete = parts.every(({ part }) => results[`part${part}`]);

    let error: string | undefined;
    if (cancelled) {
        error = 'cancelled';
    } else if (timedOut && !complete) {
        error = `timed out after ${timeoutMs} ms`;
    } else if (!exitOk && /out of memory|heap out of memory|OOM/i.test(logs)) {
        error = `ran out of memory (limit ${env.runMaxMemoryMb()} MB, RUN_MAX_MEMORY_MB to change)\n${kept.slice(-5).join('\n')}`;
    } else if (!exitOk || !complete) {
        error = failure ?? (kept.slice(-30).join('\n') || 'the solution produced no result');
    }
    const success = !error;

    if (record) {
        for (const { part } of parts) {
            const result = results[`part${part}`];
            insertRun(source, group, puzzle, {
                part,
                answer: result?.answer ?? null,
                timeMs: result?.timeMs ?? null,
                iterations,
                success: !!result,
                error: result ? null : (error ?? 'no result produced'),
            });
        }
    }

    let readmeUpdated = false;
    let git: GitOutcome | undefined;
    if (success && options.updateReadme && !customInput && !debug) {
        const title = await getTitle(source, group, puzzle);
        const existing = await readReadme(source, group, puzzle);
        await writeReadme(source, group, puzzle, renderReadme(source, group, puzzle, title ?? 'untitled', results, existing ?? undefined));
        readmeUpdated = true;
        if (options.commit) {
            handlers.onLog?.('— committing and pushing the puzzle —');
            git = await publishPuzzle(source, group, puzzle, title);
            handlers.onLog?.(`— ${git.message} —`);
        }
    }

    return { success, error, results, logs, logLines, durationMs, iterations, readmeUpdated, cancelled, git };
};
