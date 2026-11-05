# Puzzle Hub

A self-hosted workbench for programming-puzzle sites: [Advent of Code](https://adventofcode.com), [Everybody Codes](https://everybody.codes), the [AquaQ Challenges](https://challenges.aquaq.co.uk), or anything else that hands you a text input and asks for an answer in one or more parts.

The hub itself contains no puzzles. You mount one or more **source repositories** (your solutions, one repo per site), each described by a small `puzzlehub.json`, and the hub gives all of them the same tooling:

- a **dashboard** per site with titles, stars and what is on disk
- an **editor** with dockable panels: puzzle text, Monaco, input, runner with live console output, example tests, an in-browser debugger, run and answer history, README/writeup
- a **CLI** and a **JSON API** that do the same things (fetch, run, profile, submit, bulk download)
- solutions run in a sandboxed subprocess with a timeout and a memory cap; profiling writes the results table into the puzzle's README and commits + pushes the puzzle in its own repository

```
puzzle-hub/                 this repository: backend (Deno), frontend (vanilla TypeScript), no puzzles
├── hub.json                which source repositories are mounted (yours; gitignored)
└── data/                   site credentials, private to this machine (gitignored)

advent-of-code/             a source repository: just solutions + a manifest
├── puzzlehub.json
├── hub.db                  titles, answers, run history (sqlite; travels with the repo)
└── puzzles/2024/day01/     solution.ts, README.md, examples.json  (+ input.txt, puzzle.md: gitignored)
```

## Quick start

You need [Deno](https://deno.com) 2.9+.

```bash
git clone https://github.com/CodingAP/puzzle-hub && cd puzzle-hub
cp hub.example.json hub.json     # list the folders of your source repositories
deno task build                  # bundle the frontend once
deno task serve                  # http://localhost:8000
```

`hub.json`:

```json
{
    "title": "My Puzzle Hub",
    "contact": "https://github.com/you/your-puzzle-repo by you@example.com",
    "sources": ["../advent-of-code", "../everybody-codes"]
}
```

`contact` is sent as the `User-Agent` of every request the hub makes to a puzzle site, so its owner can reach you; please fill it in. Paths are relative to `hub.json`. Everything can also come from the environment (a `.env` next to `deno.json` is loaded automatically):

| variable | meaning |
| --- | --- |
| `HUB_SOURCES` | comma separated source folders (overrides `hub.json`) |
| `HUB_TITLE`, `HUB_CONTACT` | override the same fields |
| `HUB_CONFIG` | path of `hub.json` (default: next to `deno.json`) |
| `HUB_DATA_DIR` | where credentials are kept (default `./data`) |
| `API_TOKEN` | when set, every API call needs `Authorization: Bearer <token>`; set it whenever the hub is reachable by anyone else |
| `PORT` | default 8000 |
| `RUN_TIMEOUT_MS`, `RUN_MAX_MEMORY_MB` | limits for a solution run (120000 ms, 2048 MB) |
| `SESSION_<PROVIDER>` | fallback site credential, e.g. `SESSION_ADVENT_OF_CODE`, for containers that cannot keep a data folder |

Site credentials (session cookies) are entered in the Settings panel or with `deno task cli credential`, and stored in `data/local.json`. They are never returned by the API and never written into a source repository.

## Making a repository a source

Put a `puzzlehub.json` in its root:

```json
{
    "id": "advent-of-code",
    "name": "Advent of Code",
    "provider": "advent-of-code",
    "repository": "https://github.com/you/advent-of-code",
    "layout": {
        "puzzle": "puzzles/{group}/day{puzzle:2}",
        "solution": "solution.ts",
        "input": "input.txt"
    },
    "runner": { "kind": "module", "exports": "part{part}" },
    "template": "template.ts",
    "data": "hub.db"
}
```

| field | meaning |
| --- | --- |
| `id` | unique among the mounted sources; lower case letters, digits, dashes. Used in URLs. |
| `name` | shown in the UI (default: the provider's name) |
| `provider` | which site this is: `advent-of-code`, `everybody-codes`, `aquaq`, or `manual` |
| `repository` | web URL, for "source code" links (optional) |
| `layout.puzzle` | folder of one puzzle. `{group}` is the year / event / story, `{puzzle}` the number, `{puzzle:2}` zero padded. Leave `{group}` out when the site has no groups. |
| `layout.solution` | file name of the solution inside that folder (default `solution.ts`) |
| `layout.input` | default `input.txt`, or `inputs/input{part}.txt` on sites where every part has its own input |
| `layout.readme`, `layout.description`, `layout.examples` | default `README.md`, `puzzle.md`, `examples.json` |
| `parts` | parts per puzzle (default: the provider's) |
| `runner` | how a solution is executed, see below |
| `template` | file a new solution starts from; `%TITLE% %PATH% %DATE% %GROUP% %PUZZLE%` are filled in |
| `data` | sqlite file for titles, answers and runs (default `hub.db`) |
| `groups` | extra or overriding groups: `[{ "id": "2019", "label": "2019", "puzzles": 25 }]` (required for `manual`) |
| `labels` | what a group and a puzzle are called: `{ "group": "year", "puzzle": "day" }` |
| `publish` | `{ "enabled": false }` to never commit from the hub, `{ "data": false }` to leave the data file out of commits |

Add to the repository's `.gitignore` whatever the site asks you not to redistribute, typically `**/input.txt`, `**/inputs/`, `**/puzzle.md`.

Already solved a pile of puzzles before using the hub? `deno task cli adopt --source=<id>` reads the titles and answers out of your existing READMEs (the `| **Results** | … |` row, or an `Answer: …` line) into the source's database so the stars show up.

### Runners

**`module`** (default) is for TypeScript / JavaScript. The solution file exports one function per part, each taking the input as a string and returning the answer (async is fine):

```ts
export const part1 = (input: string) => 42;
export const part2 = (input: string) => 'hello';
```

`"exports": "part{part}"` names them; a site with a single part can use a fixed name such as `"exports": "solution"`. The file runs in a Deno subprocess that may only read the source repository: no network, no writes, no environment. If the repository has a `deno.json`, its import map is used. Module runners get precise timing (the import is not counted) and the debugger.

**`command`** is for every other language. The command runs once per part; the last line it prints on stdout is the answer, everything else is shown as console output:

```json
"layout": { "puzzle": "{group}/day{puzzle:2}", "solution": "solution.py" },
"runner": { "kind": "command", "command": ["python3", "{solution}", "{input}", "{part}"] }
```

`{solution}`, `{input}`, `{part}` and `{dir}` are replaced; the working directory is the puzzle folder. Timing includes process start-up, and whatever the command needs (`python3`, `cargo`, …) has to be installed where the hub runs. Command runners are not sandboxed beyond the timeout: only mount repositories you trust.

### Providers

A provider is the one site-specific piece: how puzzles are grouped, and (optionally) how to download titles, inputs and puzzle text and how to submit answers.

| provider | groups | parts | downloads | submit |
| --- | --- | --- | --- | --- |
| `advent-of-code` | years, as many days as the calendar shows | 2, one input | title, input, text | yes |
| `everybody-codes` | events (20 quests) and stories (3 quests), as listed in the site's own calendar | 3, an input per part | title, inputs, text (decrypted with your keys), answers already accepted | yes |
| `aquaq` | one list of challenges, numbered from 0 | 1 | input; title and text best effort | check on the site, then record |
| `manual` | whatever the manifest's `groups` say | manifest's `parts` | nothing: paste inputs in the Input panel | record only |

How many puzzles a site has is not hard-coded: `advent-of-code` reads each year's public calendar page (finished years once, the running event hourly, and the day that unlocks at midnight US Eastern shows up by the clock alone), `aquaq` reads the public challenge list (which also supplies the titles) and `everybody-codes` reads the calendar its web app ships (so a quest appears a minute after it opens). The answer is cached in the data folder and refreshed about once a day (`deno task cli discover --source=<id>` forces it); the built-in numbers are only a fallback, and a manifest's `groups` or folders that already exist on disk always count too.

Puzzle text is normally converted to markdown. Sites whose pages depend on their own markup (Everybody Codes' story boxes and diagrams, AquaQ's example boxes) keep it instead: a provider can return `format: 'html'`, and the frontend rebuilds that markup from an allow list of tags and attributes before showing it, so it cannot run code or load anything.

To add a site, write a `Provider` (see [backend/src/providers/mod.ts](backend/src/providers/mod.ts) for the interface and [advent-of-code.ts](backend/src/providers/advent-of-code.ts) for a complete example) and register it in `mod.ts`. Only `groups`, `puzzleUrl` and `heading` are required; `discover`, every `fetch*` and `submit` are optional and the UI adapts to what exists. Be a good citizen: providers send your `contact` as the User-Agent and nothing is requested unless you ask for it.

## CLI

```bash
deno task cli                                   # commands and arguments
deno task cli sources                           # what is mounted (add --source to list groups, --group to list puzzles)
deno task cli fetch   --source=advent-of-code --year=2024 --day=1
deno task cli run     --source=advent --year=2024 --day=1 --part=2     # --input=file.txt runs an example instead
deno task cli profile --source=everybody --group=event2024 --quest=3   # 10 iterations, README table, commit + push (--push=false)
deno task cli submit  --source=advent --year=2024 --day=1 --part=1     # --record=true stores it without contacting the site
deno task cli update  --source=advent                                  # download every missing input and puzzle text
deno task cli credential --source=advent --value=<session cookie>
deno task cli adopt   --source=aquaq
deno task cli discover --source=aquaq                                  # ask the site what it has published right now
deno task cli serve   --port=8000
```

`--source` can be shortened and may be omitted when only one source is mounted (or `HUB_SOURCE` is set). `--group` has the aliases `--year` and `--event`; `--puzzle` has `--day`, `--quest` and `--challenge`. During an Advent of Code December, `fetch` with no arguments means today's puzzle.

## Web UI

The platform menu in the top right switches between sources in both views (the editor returns to where you last were on that platform). The editor's panels (Puzzle, Puzzles, Input, Code, Runner, Tests, Debugger, Runs, Submissions, README, Settings) can be dragged into tabs and splits; layouts and presets are remembered per browser. `#/<source>/<group>/<puzzle>` links straight to a puzzle.

- **Runner** streams console output while the solution runs; cancel kills the process. Profile averages over N iterations, rewrites the README's results table (everything from `%%%` on is your writeup and is left alone) and publishes the puzzle with git.
- **Tests** runs example inputs: code blocks from the puzzle text are offered automatically, saved ones (with expected answers per part) live in `examples.json` next to the solution.
- **Debugger** (module runners) works in any browser: breakpoints in the editor gutter, step, call stack, scopes, evaluate. It speaks the Chrome DevTools Protocol to Deno's inspector through a websocket the API proxies.
- **Themes** in Settings → appearance: pick a theme, then its mode (light, dark, or automatic to follow the operating system); every theme has both. With "match the theme to the site" on, Advent of Code, Everybody Codes and AquaQ puzzles switch to their own look. A theme is two blocks of CSS variables in `frontend/static/styles.css` (`[data-theme='x']` and `[data-theme='x'][data-mode='light']` or `'dark'`) plus editor colours for both modes in `frontend/src/themes.ts`.

The editor wants a desktop-sized screen; the dashboard works on a phone.

## API

Everything the UI does goes through `/api` (bearer token when `API_TOKEN` is set).

| method | path | |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, version, auth }` (no token needed) |
| GET | `/api/hub` | title and the mounted sources with their capabilities |
| GET | `/api/sources/:source/groups` | groups with star counts |
| GET | `/api/sources/:source/groups/:group` | puzzles of a group |
| GET, PUT | `/api/sources/:source/credential` | credential status / store `{ value }` (never returned) |
| GET | `/api/sources/:source/puzzles/:group/:puzzle` | title, stars, files, answers, runs, readme |
| POST | `…/fetch` | scaffold the solution and download inputs + text (`{ inputOnly }`) |
| GET, PUT | `…/solution` | `{ code }` |
| GET, PUT | `…/input` | `?part=N` / `{ part, content }` |
| GET, PUT | `…/readme` | markdown / `{ content }` |
| GET, POST | `…/description` | stored puzzle text / download it again |
| GET, PUT | `…/examples` | saved examples |
| POST | `…/run` | `{ part, iterations, updateReadme, commit, input, debug, timeoutMs, stream }`; with `stream` the reply is server-sent events (`start`, `log`, `inspector`, `result`, `error`) |
| POST | `…/submit` | `{ part, record }` |
| GET, POST | `/api/bulk` | status / start a download for `{ source, onlyMissing, inputs, descriptions }` |
| GET | `/api/debug/ws/:token` | inspector websocket for the active debug run |

## Deploying

```bash
docker build -t puzzle-hub .
docker run -p 8000:8000 --user 1000:1000 \
    -e API_TOKEN=change-me -e HUB_TITLE="My Puzzle Hub" -e HUB_CONTACT="github.com/you" \
    -e HUB_SOURCES=/sources/advent-of-code,/sources/everybody-codes \
    -v /srv/advent-of-code:/sources/advent-of-code \
    -v /srv/everybody-codes:/sources/everybody-codes \
    -v puzzle-hub-data:/data \
    puzzle-hub
```

Mount each source as a normal git checkout so profiling can commit and push from it; for that the container needs credentials for the remote (for example a deploy key with write access per repository, wired up with `GIT_SSH_COMMAND` and a mounted ssh config) and an identity (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`). Without them everything else still works and the runner reports that the push failed.

The hub runs code from the mounted repositories and can edit them, so treat `API_TOKEN` like a shell password: always set it on a public host, put the hub behind TLS, and give the container memory, CPU and pid limits.
