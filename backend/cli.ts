/**
 * backend/cli.ts
 *
 * command line interface of the puzzle hub. every puzzle is addressed as --source / --group / --puzzle
 * (--year and --day are accepted as aliases for sources that are organised that way).
 */

import { adoptReadmes } from './src/adopt.ts';
import { bulkDownload } from './src/bulk.ts';
import { parsePartSpec, type PartSpec, VERSION } from './src/config.ts';
import { DEBUG_PORT } from './src/debug.ts';
import { refreshDiscovery } from './src/discovery.ts';
import { listGroup, listGroups, scaffoldPuzzle } from './src/puzzles.ts';
import { runPuzzle, type RunResults } from './src/runner.ts';
import { getCredentialInfo, LOCAL_CONFIG_PATH, setCredential } from './src/session.ts';
import { assertPuzzle, getHubConfig, listGroupInfos, loadSources, type Source } from './src/sources.ts';
import { submitAnswer } from './src/submit.ts';

type ArgumentName = 'source' | 'group' | 'puzzle' | 'part' | 'iterations' | 'record' | 'port' | 'missing' | 'value' | 'clear' | 'input' | 'debug' | 'push';
type Arguments = Record<ArgumentName, string>;

interface CommandInfo {
    aliases: string[];
    description: string;
    arguments: ArgumentName[];
    command: (args: Arguments) => Promise<void>;
}

interface ArgumentInfo {
    aliases: string[];
    description: string;
    default: string;
    expects?: string[]; // omitted = any value
}

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const log = (message: string) => console.log(`${RED}hub: ${GREEN}${message}${RESET}`);
const fail = (message: string) => console.log(`${RED}hub: error - ${message}${RESET}`);
const hl = (value: unknown) => `${YELLOW}${value}${GREEN}`;

/** --source may be omitted when only one source is mounted (or HUB_SOURCE names the usual one) */
const resolveSource = async (args: Arguments): Promise<Source> => {
    const sources = await loadSources();
    if (sources.length === 0) throw new Error('no sources are mounted: list their folders in hub.json (or HUB_SOURCES)');
    const wanted = args.source || Deno.env.get('HUB_SOURCE') || (sources.length === 1 ? sources[0].id : '');
    if (!wanted) throw new Error(`pick one with --source: ${sources.map((source) => source.id).join(', ')}`);
    const source = sources.find((candidate) => candidate.id === wanted) ?? sources.find((candidate) => candidate.id.startsWith(wanted));
    if (!source) throw new Error(`unknown source '${wanted}' (mounted: ${sources.map((candidate) => candidate.id).join(', ')})`);
    return source;
};

interface Target {
    source: Source;
    group: string;
    puzzle: number;
    where: string;
}

/** fills in what was left out: the provider's idea of "today", else the newest group */
const resolveTarget = async (args: Arguments): Promise<Target> => {
    const source = await resolveSource(args);
    const today = source.provider.current?.(new Date()) ?? null;
    const groups = await listGroupInfos(source);
    const group = args.group || today?.group || groups.at(-1)?.id || '';
    const puzzle = args.puzzle !== '' ? Number(args.puzzle) : !args.group || args.group === today?.group ? today?.puzzle ?? NaN : NaN;
    if (Number.isNaN(puzzle)) throw new Error(`which ${source.labels.puzzle}? pass --puzzle=<number>`);
    await assertPuzzle(source, group, puzzle);
    const where = `${hl(source.name)} ${groups.length > 1 ? `${hl(group)} ` : ''}${source.labels.puzzle} ${hl(puzzle)}`;
    return { source, group, puzzle, where };
};

const parsePart = (source: Source, value: string): PartSpec => {
    const part = parsePartSpec(value, source.parts);
    if (part === null) throw new Error(`--part must be 'all' or 1-${source.parts} for ${source.name}`);
    return part;
};

const printRun = (results: RunResults) => {
    for (const [name, result] of Object.entries(results)) {
        log(`${name.replace('part', 'part ')} - ${hl(result.answer)} (${hl(result.timeMs.toFixed(2) + ' ms')})`);
    }
};

const commands: Record<string, CommandInfo> = {
    sources: {
        aliases: ['ls'],
        description: 'lists the mounted sources, or with --source the groups of one, or with --group its puzzles.',
        arguments: ['source', 'group'],
        command: async (args) => {
            if (!args.source && !args.group) {
                const sources = await loadSources();
                if (sources.length === 0) return fail('no sources are mounted: list their folders in hub.json (or HUB_SOURCES)');
                for (const source of sources) {
                    const groups = await listGroups(source);
                    const stars = groups.reduce((sum, group) => sum + group.stars, 0);
                    log(`${hl(source.id)} - ${source.name} (${source.provider.name}): ${hl(groups.length)} ${source.labels.group || 'group'}(s), ${
                        hl(stars)
                    } stars, ${source.root}`);
                }
                return;
            }
            const source = await resolveSource(args);
            if (!args.group) {
                for (const group of await listGroups(source)) {
                    log(`${hl(group.id)} - ${group.label}: ${hl(group.stars)}/${group.maxStars} stars, ${group.puzzles.length} ${source.labels.puzzle}s`);
                }
                return;
            }
            for (const puzzle of await listGroup(source, args.group)) {
                const flags = [puzzle.hasSolution ? 'solution' : '', puzzle.hasInput ? 'input' : ''].filter(Boolean).join(', ') || 'not started';
                log(`${hl(String(puzzle.puzzle).padStart(2))} ${'*'.repeat(puzzle.stars).padEnd(source.parts)} ${puzzle.title ?? '(no title yet)'} [${flags}]`);
            }
        },
    },
    fetch: {
        aliases: ['f'],
        description: 'creates the solution folder for a puzzle and downloads its input(s) and text where the site allows it.',
        arguments: ['source', 'group', 'puzzle'],
        command: async (args) => {
            const { source, group, puzzle, where } = await resolveTarget(args);
            const { createdSolution, inputError } = await scaffoldPuzzle(source, group, puzzle);
            log(`${createdSolution ? `generated ${source.layout.solution}` : `${source.layout.solution} already existed`} for ${where}!`);
            if (inputError) fail(`input not downloaded: ${inputError}`);
            else log('input downloaded!');
        },
    },
    run: {
        aliases: ['r'],
        description: 'runs the solution and prints the answers.',
        arguments: ['source', 'group', 'puzzle', 'part', 'input', 'debug'],
        command: async (args) => {
            const { source, group, puzzle, where } = await resolveTarget(args);
            const debug = args.debug === 'true';
            log(`running ${where}${args.input ? ` with input ${hl(args.input)}` : ''}${debug ? ' under the debugger' : ''}!`);
            const input = args.input ? await Deno.readTextFile(args.input) : undefined;
            const outcome = await runPuzzle(source, group, puzzle, { part: parsePart(source, args.part), input, debug }, {
                onLog: (line) => console.log(line),
                onInspector: () => log(`debugger listening on ${hl(`127.0.0.1:${DEBUG_PORT}`)}: open ${hl('chrome://inspect')} and press resume`),
            });
            if (!outcome.success) return fail(outcome.error ?? 'unknown error');
            printRun(outcome.results);
        },
    },
    profile: {
        aliases: ['p'],
        description: 'times every part over several iterations, writes the results table to the readme, and commits + pushes the puzzle.',
        arguments: ['source', 'group', 'puzzle', 'iterations', 'push'],
        command: async (args) => {
            const { source, group, puzzle, where } = await resolveTarget(args);
            log(`profiling ${where} (${hl(args.iterations)} iterations)!`);
            const outcome = await runPuzzle(source, group, puzzle, {
                part: 'all',
                iterations: Number(args.iterations),
                updateReadme: true,
                commit: args.push === 'true',
            });
            if (!outcome.success) return fail(outcome.error ?? 'unknown error');
            printRun(outcome.results);
            log(`profiling complete! results are in the ${hl('readme')} in the solution directory!`);
            if (outcome.git) (outcome.git.pushed || !outcome.git.committed ? log : fail)(`git: ${outcome.git.message}`);
        },
    },
    submit: {
        aliases: ['s'],
        description: 'submits the answer to the site (where it accepts them), or with --record=true just stores it as correct.',
        arguments: ['source', 'group', 'puzzle', 'part', 'record'],
        command: async (args) => {
            const { source, group, puzzle, where } = await resolveTarget(args);
            log(`submitting answers for ${where}!`);
            const outcome = await submitAnswer(source, group, puzzle, parsePart(source, args.part), args.record === 'true');
            for (const [name, result] of Object.entries(outcome)) log(`${name.replace('part', 'part ')} - ${hl(result.answer)}: ${result.message}`);
        },
    },
    update: {
        aliases: ['u'],
        description: 'downloads inputs and puzzle text for every published puzzle of a source (neither is stored in git).',
        arguments: ['source', 'missing'],
        command: async (args) => {
            const source = await resolveSource(args);
            let last = '';
            const result = await bulkDownload(source, { onlyMissing: args.missing === 'true' }, (status) => {
                if (status.current && status.current !== last) {
                    last = status.current;
                    log(`[${hl(status.done + 1)}/${hl(status.total)}] ${status.current}`);
                }
            });
            log(`done: ${hl(result.downloaded)} downloaded, ${hl(result.skipped)} skipped, ${hl(result.errors.length)} errors`);
            for (const error of result.errors) fail(error);
        },
    },
    adopt: {
        aliases: ['import'],
        description: 'reads titles and answers out of the existing readmes into the source database (for repositories solved before the hub).',
        arguments: ['source'],
        command: async (args) => {
            const source = await resolveSource(args);
            const result = await adoptReadmes(source);
            log(`${hl(source.name)}: read ${hl(result.puzzles)} readmes, stored ${hl(result.titles)} titles and ${hl(result.answers)} answers.`);
        },
    },
    discover: {
        aliases: ['refresh'],
        description: 'asks the site of a source which groups and puzzles it has published right now (done automatically about once a day).',
        arguments: ['source'],
        command: async (args) => {
            const source = await resolveSource(args);
            if (!source.provider.discover) return log(`${source.provider.name} cannot be asked: its puzzles come from the manifest.`);
            const entry = await refreshDiscovery(source);
            if (!entry) return fail(`${source.provider.name} could not be reached; the last known list stays in use.`);
            for (const group of entry.groups) log(`${hl(group.id)} - ${group.label}: ${hl(group.puzzles.length)} ${source.labels.puzzle}s`);
        },
    },
    credential: {
        aliases: ['session'],
        description: "shows or stores the site credential of a source's provider (kept in the hub's data folder, never in git).",
        arguments: ['source', 'value', 'clear'],
        command: async (args) => {
            const source = await resolveSource(args);
            const provider = source.provider;
            if (!provider.credential) return log(`${provider.name} needs no credential.`);
            const clear = args.clear === 'true';
            const info = clear
                ? await setCredential(provider.id, null)
                : args.value
                ? await setCredential(provider.id, args.value)
                : await getCredentialInfo(provider.id);
            if (clear) log(`${provider.credential.label} cleared.`);
            else if (args.value) log(`${provider.credential.label} stored in ${hl(LOCAL_CONFIG_PATH)}.`);
            if (info.configured) {
                log(`active ${provider.credential.label}: ${hl(info.preview)} (from ${hl(info.source)}${info.updated ? `, updated ${hl(info.updated)}` : ''})`);
            } else {fail(
                    `no ${provider.credential.label} configured: it is ${provider.credential.hint}. store it with \`credential --source=${source.id} --value=<it>\`.`,
                );}
        },
    },
    serve: {
        aliases: ['api', 'web'],
        description: 'starts the api server that also hosts the web frontend.',
        arguments: ['port'],
        command: async (args) => {
            const { startServer } = await import('./server.ts');
            startServer(Number(args.port) || undefined);
        },
    },
};

const argumentInfo: Record<ArgumentName, ArgumentInfo> = {
    source: { aliases: ['s'], description: 'id of the source (may be shortened; optional when only one is mounted).', default: '' },
    group: { aliases: ['g', 'year', 'y', 'event'], description: 'group of the puzzle: a year, an event, a story... defaults to the newest.', default: '' },
    puzzle: { aliases: ['n', 'day', 'd', 'quest', 'challenge'], description: 'number of the puzzle within its group.', default: '' },
    part: { aliases: ['p'], description: "which part to process: a number, or 'all'.", default: 'all' },
    iterations: { aliases: ['i'], description: 'how many times to run each part for the profiler.', default: '10' },
    record: {
        aliases: ['fake', 'f'],
        description: 'for submit: store the answer as correct without sending it to the site.',
        default: 'false',
        expects: ['true', 'false'],
    },
    port: { aliases: [], description: 'port for the api server (defaults to $PORT or 8000).', default: '' },
    value: { aliases: ['token', 't'], description: 'for credential: the value to store (usually a session cookie).', default: '' },
    clear: { aliases: [], description: 'for credential: forget the stored value.', default: 'false', expects: ['true', 'false'] },
    input: { aliases: [], description: 'for run: a file to use instead of the real input (e.g. an example); such runs are not recorded.', default: '' },
    debug: {
        aliases: [],
        description: 'for run: pause under the inspector so a debugger can attach (module runners only).',
        default: 'false',
        expects: ['true', 'false'],
    },
    push: { aliases: [], description: 'for profile: commit the puzzle folder and push it.', default: 'true', expects: ['true', 'false'] },
    missing: { aliases: ['m'], description: 'for update: only download files that are not on disk yet.', default: 'true', expects: ['true', 'false'] },
};

const getPrompt = (): string => {
    let prompt = '\tcommands:\n';
    for (const [command, info] of Object.entries(commands)) {
        prompt += `\t\t${GREEN}${command} ${RED}${info.arguments.map((arg) => `--${arg}`).join(' ')}\n`;
        prompt += `\t\t\t${YELLOW}aliases: ${RESET}${info.aliases.join(', ') || 'none'}\n`;
        prompt += `\t\t\t${YELLOW}description: ${RESET}${info.description}\n`;
    }
    prompt += '\targuments:\n';
    for (const [argument, info] of Object.entries(argumentInfo)) {
        prompt += `\t\t${GREEN}--${argument}\n`;
        prompt += `\t\t\t${YELLOW}aliases: ${RESET}${info.aliases.map((alias) => `--${alias}`).join(', ') || 'none'}\n`;
        prompt += `\t\t\t${YELLOW}description: ${RESET}${info.description}\n`;
        if (info.expects) prompt += `\t\t\t${YELLOW}expects: ${RESET}${info.expects.join(', ')}\n`;
        if (info.default) prompt += `\t\t\t${YELLOW}default: ${RESET}${info.default}\n`;
    }
    return prompt;
};

const handleCommandLine = async (args: string[]): Promise<void> => {
    const title = await getHubConfig().then((config) => config.title.toLowerCase(), () => 'puzzle hub');
    console.log(`\n${YELLOW}~~~ ${GREEN}${title} ${RED}v${VERSION} ${YELLOW}~~~${RESET}\n`);

    if (args.length === 0) return console.log(getPrompt());

    const commandName = args[0];
    const command = Object.entries(commands).find(([name, info]) => name === commandName || info.aliases.includes(commandName))?.[1];
    if (!command) {
        console.log(`${RED}error: unknown command '${commandName}'${RESET}`);
        return console.log(getPrompt());
    }

    const parsed: Partial<Arguments> = {};
    for (const arg of args.slice(1)) {
        if (!arg.startsWith('--')) continue;
        const separator = arg.indexOf('=');
        const key = separator < 0 ? arg.slice(2) : arg.slice(2, separator);
        const value = separator < 0 ? 'true' : arg.slice(separator + 1);
        const found = Object.entries(argumentInfo).find(([name, info]) => name === key || info.aliases.includes(key));
        if (!found) {
            console.log(`${RED}error: unknown argument '${key}'${RESET}`);
            return console.log(getPrompt());
        }
        const [name, info] = found;
        if (info.expects && !info.expects.includes(value)) {
            console.log(`${RED}error: invalid value '${value}' for argument '${key}' (expects ${info.expects.join(' or ')})${RESET}`);
            Deno.exitCode = 1;
            return;
        }
        parsed[name as ArgumentName] = value;
    }
    for (const name of Object.keys(argumentInfo) as ArgumentName[]) parsed[name] ??= argumentInfo[name].default;

    try {
        await command.command(parsed as Arguments);
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        Deno.exitCode = 1;
    }
};

if (import.meta.main) {
    await handleCommandLine(Deno.args);
}
