/**
 * frontend/src/types.ts
 *
 * shapes returned by the backend api (mirrors backend/src)
 */

/** 'all', or a part number as a string ('1', '2', ...) */
export type Part = string;

/** every puzzle is addressed by the source (repository) it lives in, its group (year, event...) and its number */
export interface PuzzleRef {
    source: string;
    group: string;
    puzzle: number;
}

export interface CredentialInfo {
    configured: boolean;
    source: 'file' | 'env' | null;
    preview: string | null;
    updated: string | null;
}

export interface SourceInfo {
    id: string;
    name: string;
    provider: { id: string; name: string; home: string };
    /** what a group and a puzzle are called on this site, e.g. year / day ('' when there is a single group) */
    labels: { group: string; puzzle: string };
    parts: number;
    perPartInput: boolean;
    repository: string | null;
    /** extension of the solution file */
    language: string;
    solutionFile: string;
    capabilities: { fetchInputs: boolean; fetchDescription: boolean; submit: boolean; debug: boolean };
    credential: (CredentialInfo & { label: string; hint: string }) | null;
}

export interface Hub {
    title: string;
    version: string;
    sources: SourceInfo[];
}

export interface GroupSummary {
    id: string;
    label: string;
    puzzles: number[];
    stars: number;
    maxStars: number;
}

export interface PuzzleStatus {
    hasSolution: boolean;
    /** true when every input the puzzle needs is on disk */
    hasInput: boolean;
    inputs: boolean[];
    hasReadme: boolean;
    hasDescription: boolean;
}

export interface PuzzleSummary extends PuzzleStatus {
    puzzle: number;
    title: string | null;
    stars: number;
    path: string;
    repositoryUrl: string | null;
}

export interface AnswerRow {
    answer_id: number;
    grp: string;
    puzzle: number;
    part: number;
    answer: string;
    correct: number;
    created: string;
}

export interface RunRow {
    run_id: number;
    grp: string;
    puzzle: number;
    part: number;
    answer: string | null;
    time_ms: number | null;
    iterations: number;
    success: number;
    error: string | null;
    created: string;
}

export interface PuzzleDetail extends PuzzleRef, PuzzleStatus {
    title: string | null;
    url: string;
    stars: number;
    readme: string | null;
    answers: AnswerRow[];
    runs: RunRow[];
    path: string;
    repositoryUrl: string | null;
}

export interface PartResult {
    answer: string;
    timeMs: number;
}

export interface RunOutcome {
    success: boolean;
    error?: string;
    /** keyed part1, part2, ... */
    results: Record<string, PartResult | undefined>;
    logs: string;
    logLines: number;
    durationMs: number;
    iterations: number;
    readmeUpdated: boolean;
    cancelled: boolean;
    git?: { committed: boolean; pushed: boolean; commit?: string; message: string };
}

export interface RunRequest {
    part: Part;
    iterations?: number;
    updateReadme?: boolean;
    timeoutMs?: number;
    input?: string;
    debug?: boolean;
    commit?: boolean;
}

export interface RunHandlers {
    onLog?: (line: string) => void;
    onInspector?: (info: { token: string }) => void;
    onStart?: () => void;
}

export interface SubmitPartOutcome {
    answer: string;
    message: string;
    correct: boolean | null;
}

export type SubmitOutcome = Record<string, SubmitPartOutcome | undefined>;

export interface Example {
    name: string;
    input: string;
    /** keyed part1, part2, ... */
    expected?: Record<string, string | undefined>;
}

export interface Description {
    /** the text, as markdown or (format 'html') the site's own markup */
    markdown: string;
    format?: 'markdown' | 'html';
    parts: number;
    fetchedAt: string | null;
}

export interface BulkOptions {
    onlyMissing: boolean;
    inputs: boolean;
    descriptions: boolean;
}

export interface BulkStatus {
    running: boolean;
    source: string | null;
    total: number;
    done: number;
    downloaded: number;
    skipped: number;
    current: string | null;
    errors: string[];
    startedAt: string | null;
    finishedAt: string | null;
    options: BulkOptions | null;
}

export interface Health {
    ok: boolean;
    version: string;
    auth: boolean;
}
