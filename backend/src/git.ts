/**
 * backend/src/git.ts
 *
 * commits a puzzle's files in its source repository and pushes them, so profiling a solution also publishes it
 */

import { closeDatabase } from './db.ts';
import { exists } from './fs.ts';
import { puzzlePaths, type Source } from './sources.ts';

export interface GitOutcome {
    committed: boolean;
    pushed: boolean;
    commit?: string; // short hash when something was committed
    message: string; // human readable summary (also carries the error when something failed)
}

const git = async (source: Source, ...args: string[]): Promise<{ ok: boolean; out: string }> => {
    try {
        const result = await new Deno.Command('git', { args, cwd: source.root, stdin: 'null', stdout: 'piped', stderr: 'piped' }).output();
        return { ok: result.success, out: (new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).trim() };
    } catch (error) {
        return { ok: false, out: error instanceof Error ? error.message : String(error) };
    }
};

/**
 * stages the puzzle folder (ignored files such as inputs stay out) and the source's data file, commits only those
 * paths, and pushes. nothing to commit is not an error; a rejected push is retried once after a rebase.
 */
export const publishPuzzle = async (source: Source, group: string, puzzle: number, title: string | null): Promise<GitOutcome> => {
    if (source.manifest.publish?.enabled === false) return { committed: false, pushed: false, message: "publishing is turned off in this source's manifest" };

    const inside = await git(source, 'rev-parse', '--is-inside-work-tree');
    if (!inside.ok) return { committed: false, pushed: false, message: `not a git checkout: ${inside.out}` };

    const paths = [puzzlePaths(source, group, puzzle).directory.slice(source.root.length + 1)];
    if (source.manifest.publish?.data !== false && source.dataPath.startsWith(source.root + '/') && (await exists(source.dataPath))) {
        const data = source.dataPath.slice(source.root.length + 1);
        // only when git would track it: an ignored data file stays private
        if (!(await git(source, 'check-ignore', '-q', '--', data)).ok) paths.push(data);
    }

    const add = await git(source, 'add', '--', ...paths);
    if (!add.ok) return { committed: false, pushed: false, message: `git add failed: ${add.out}` };

    const staged = await git(source, 'diff', '--cached', '--quiet', '--', ...paths);
    if (staged.ok) return { committed: false, pushed: false, message: 'nothing new to commit' };

    const subject = `${source.labels.group ? `${group} ` : ''}${source.labels.puzzle} ${puzzle}${title ? `: ${title}` : ''}`;
    const commit = await git(source, 'commit', '-q', '-m', subject, '--', ...paths);
    if (!commit.ok) return { committed: false, pushed: false, message: `git commit failed: ${commit.out}` };
    const hash = (await git(source, 'rev-parse', '--short', 'HEAD')).out;

    let push = await git(source, 'push', '--quiet');
    if (!push.ok && /rejected|fetch first|non-fast-forward/i.test(push.out)) {
        // the pull replaces the data file, and a handle to the old one can no longer write: let go of it before, and
        // again after in case a request opened the file while git was at work
        closeDatabase(source);
        const rebase = await git(source, 'pull', '--rebase', '--autostash', '--quiet');
        if (!rebase.ok) await git(source, 'rebase', '--abort');
        closeDatabase(source);
        if (!rebase.ok) {
            return {
                committed: true,
                pushed: false,
                commit: hash,
                message: `committed ${hash}, but the remote has new commits and rebasing failed: ${rebase.out}`,
            };
        }
        push = await git(source, 'push', '--quiet');
    }
    if (!push.ok) return { committed: true, pushed: false, commit: hash, message: `committed ${hash}, but push failed: ${push.out}` };

    return { committed: true, pushed: true, commit: hash, message: `committed ${hash} and pushed` };
};
