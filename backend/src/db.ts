/**
 * backend/src/db.ts
 *
 * every source keeps its own sqlite file (titles, submitted answers, run history) next to its puzzles,
 * so a puzzle repository carries its own progress
 */

import { DatabaseSync } from 'node:sqlite';
import type { Source } from './sources.ts';

export interface AnswerRow {
    answer_id: number;
    grp: string;
    puzzle: number;
    part: number;
    answer: string;
    correct: number; // 1 = correct, 0 = incorrect
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

const databases = new Map<string, DatabaseSync>();

const tableExists = (database: DatabaseSync, name: string): boolean =>
    database.prepare(`select 1 from sqlite_master where type = 'table' and name = ?`).get(name) !== undefined;

const hasColumn = (database: DatabaseSync, table: string, column: string): boolean =>
    (database.prepare(`pragma table_info(${table})`).all() as { name: string }[]).some((row) => row.name === column);

/**
 * the advent-of-code-only tool stored year/day; move that data into the generic tables once
 */
const migrateLegacy = (database: DatabaseSync) => {
    if (tableExists(database, 'runs') && hasColumn(database, 'runs', 'year')) {
        database.exec(`alter table runs rename to runs_legacy`);
    }
    createSchema(database);
    if (tableExists(database, 'puzzles')) {
        database.exec(`
            insert or ignore into titles (grp, puzzle, title, created)
                select year, cast(day as integer), title, created from puzzles where title != 'no title available!';
            drop table puzzles;
        `);
    }
    if (tableExists(database, 'puzzle_answers')) {
        database.exec(`
            insert into answers (grp, puzzle, part, answer, correct, created)
                select year, cast(day as integer), cast(part as integer), answer, result, created from puzzle_answers order by answer_id;
            drop table puzzle_answers;
        `);
    }
    if (tableExists(database, 'runs_legacy')) {
        database.exec(`
            insert into runs (grp, puzzle, part, answer, time_ms, iterations, success, error, created)
                select year, cast(day as integer), cast(part as integer), answer, time_ms, iterations, success, error, created from runs_legacy order by run_id;
            drop table runs_legacy;
        `);
    }
};

const createSchema = (database: DatabaseSync) => {
    database.exec(`
        create table if not exists titles (
            grp text not null,
            puzzle integer not null,
            title text not null,
            created text not null,
            primary key (grp, puzzle)
        );

        create table if not exists answers (
            answer_id integer primary key autoincrement,
            grp text not null,
            puzzle integer not null,
            part integer not null,
            answer text not null,
            correct integer not null,
            created text not null
        );

        create table if not exists runs (
            run_id integer primary key autoincrement,
            grp text not null,
            puzzle integer not null,
            part integer not null,
            answer text,
            time_ms real,
            iterations integer not null,
            success integer not null,
            error text,
            created text not null
        );

        create index if not exists answers_puzzle on answers (grp, puzzle);
        create index if not exists runs_puzzle on runs (grp, puzzle, created);
    `);
};

/**
 * opens (once per process) a source's database and makes sure the schema exists
 */
export const getDatabase = (source: Source): DatabaseSync => {
    const cached = databases.get(source.dataPath);
    if (cached) return cached;
    const database = new DatabaseSync(source.dataPath);
    migrateLegacy(database);
    databases.set(source.dataPath, database);
    return database;
};

const now = () => new Date().toISOString();

export const getStoredTitle = (source: Source, group: string, puzzle: number): string | null => {
    const row = getDatabase(source).prepare(`select title from titles where grp = ? and puzzle = ?`).get(group, puzzle) as { title: string } | undefined;
    return row?.title ?? null;
};

export const storeTitle = (source: Source, group: string, puzzle: number, title: string): void => {
    getDatabase(source).prepare(
        `insert into titles (grp, puzzle, title, created) values (?, ?, ?, ?) on conflict(grp, puzzle) do update set title = excluded.title`,
    ).run(group, puzzle, title, now());
};

export const getTitlesForGroup = (source: Source, group: string): Map<number, string> => {
    const rows = getDatabase(source).prepare(`select puzzle, title from titles where grp = ?`).all(group) as { puzzle: number; title: string }[];
    return new Map(rows.map((row) => [row.puzzle, row.title]));
};

/** stars earned for a puzzle: number of distinct parts with a correct answer */
export const getStars = (source: Source, group: string, puzzle: number): number => {
    const row = getDatabase(source).prepare(
        `select count(distinct part) as stars from answers where grp = ? and puzzle = ? and correct = 1 and part between 1 and ?`,
    ).get(group, puzzle, source.parts) as { stars: number };
    return row.stars;
};

export const getStarsForGroup = (source: Source, group: string): Map<number, number> => {
    const rows = getDatabase(source).prepare(
        `select puzzle, count(distinct part) as stars from answers where grp = ? and correct = 1 and part between 1 and ? group by puzzle`,
    ).all(group, source.parts) as { puzzle: number; stars: number }[];
    return new Map(rows.map((row) => [row.puzzle, row.stars]));
};

export const getStarsByGroup = (source: Source): Map<string, number> => {
    const rows = getDatabase(source).prepare(
        `select grp, count(*) as stars from (select distinct grp, puzzle, part from answers where correct = 1 and part between 1 and ?) group by grp`,
    ).all(source.parts) as { grp: string; stars: number }[];
    return new Map(rows.map((row) => [row.grp, row.stars]));
};

export const getAnswers = (source: Source, group: string, puzzle: number): AnswerRow[] =>
    getDatabase(source).prepare(`select * from answers where grp = ? and puzzle = ? order by created desc, answer_id desc`).all(
        group,
        puzzle,
    ) as unknown as AnswerRow[];

export const findAnswer = (source: Source, group: string, puzzle: number, part: number, answer: string): AnswerRow | null => {
    const row = getDatabase(source).prepare(`select * from answers where grp = ? and puzzle = ? and part = ? and answer = ?`).get(
        group,
        puzzle,
        part,
        answer,
    ) as
        | AnswerRow
        | undefined;
    return row ?? null;
};

export const insertAnswer = (source: Source, group: string, puzzle: number, part: number, answer: string, correct: boolean): void => {
    getDatabase(source).prepare(`insert into answers (grp, puzzle, part, answer, correct, created) values (?, ?, ?, ?, ?, ?)`).run(
        group,
        puzzle,
        part,
        answer,
        correct ? 1 : 0,
        now(),
    );
};

export interface NewRun {
    part: number;
    answer: string | null;
    timeMs: number | null;
    iterations: number;
    success: boolean;
    error: string | null;
}

export const insertRun = (source: Source, group: string, puzzle: number, run: NewRun): void => {
    getDatabase(source).prepare(
        `insert into runs (grp, puzzle, part, answer, time_ms, iterations, success, error, created) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(group, puzzle, run.part, run.answer, run.timeMs, run.iterations, run.success ? 1 : 0, run.error, now());
};

export const getRuns = (source: Source, group: string, puzzle: number, limit = 100): RunRow[] =>
    getDatabase(source).prepare(`select * from runs where grp = ? and puzzle = ? order by created desc, run_id desc limit ?`).all(
        group,
        puzzle,
        limit,
    ) as unknown as RunRow[];
