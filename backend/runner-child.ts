/**
 * backend/runner-child.ts
 *
 * executed in a subprocess by src/runner.ts: imports a solution module, runs the requested parts, and prints one json
 * line to stdout. anything the solution logs goes to stderr so stdout stays machine readable.
 *
 * usage: deno run --allow-read runner-child.ts '<json spec>'
 *   spec: { solution: string, iterations: number, parts: [{ part: number, input: string, export: string }] }
 */

import { toFileUrl } from './src/fs.ts';

interface Spec {
    solution: string;
    iterations: number;
    parts: { part: number; input: string; export: string }[];
}

const spec: Spec = JSON.parse(Deno.args[0]);
const iterations = Math.max(1, Number(spec.iterations) || 1);

const encoder = new TextEncoder();
const emit = (payload: unknown) => Deno.stdout.writeSync(encoder.encode(JSON.stringify(payload) + '\n'));

// keep stdout for the result only
console.log = console.error;
console.info = console.error;
console.debug = console.error;

try {
    const solution = await import(toFileUrl(spec.solution).href);
    const results: Record<string, { answer: string; timeMs: number }> = {};
    const inputs = new Map<string, string>();

    for (const { part, input, export: name } of spec.parts) {
        const fn = solution[name];
        if (typeof fn !== 'function') throw new Error(`solution does not export ${name}`);
        if (!inputs.has(input)) inputs.set(input, (await Deno.readTextFile(input)).replace(/\r/g, ''));
        const text = inputs.get(input)!;

        let answer: unknown;
        let total = 0;
        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            answer = await fn(text);
            total += performance.now() - start;
        }
        results[`part${part}`] = { answer: String(answer), timeMs: total / iterations };
    }

    emit({ results });
} catch (error) {
    emit({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    Deno.exit(1);
}
