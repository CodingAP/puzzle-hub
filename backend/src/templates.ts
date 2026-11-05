/**
 * backend/src/templates.ts
 *
 * the solution file a freshly fetched puzzle starts with: the source's own template when it has one,
 * otherwise a skeleton generated from its runner configuration
 */

import { join, readTextOrNull } from './fs.ts';
import { puzzlePaths, type Source } from './sources.ts';

const today = () => {
    const now = new Date();
    return `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
};

export const solutionTemplate = async (source: Source, group: string, puzzle: number, title: string): Promise<string> => {
    const relativePath = puzzlePaths(source, group, puzzle).solution.slice(source.root.length + 1);

    if (source.manifest.template) {
        const template = await readTextOrNull(join(source.root, source.manifest.template));
        if (template !== null) {
            return template
                .replace(/%TITLE%/g, title)
                .replace(/%PATH%/g, relativePath)
                .replace(/%DATE%/g, today())
                .replace(/%GROUP%/g, group)
                .replace(/%PUZZLE%/g, String(puzzle));
        }
    }

    // other languages start empty: the hub cannot guess their boilerplate
    if (source.runner.kind !== 'module') return '';

    const typed = source.layout.solution.endsWith('.ts');
    const pattern = source.runner.exports ?? 'part{part}';
    const names = pattern.includes('{part}') ? Array.from({ length: source.parts }, (_, index) => pattern.replace('{part}', String(index + 1))) : [pattern];
    const functions = names.map((name, index) =>
        `/**\n * ${names.length > 1 ? `the code of part ${index + 1} of the puzzle` : 'the code of the puzzle'}\n */\nconst ${name} = (input${
            typed ? ': string' : ''
        }) => {\n    return 0;\n};\n`
    );

    return `/**\n * ${relativePath}\n *\n * ~~ ${title} ~~\n * this is my solution for this ${source.name} puzzle\n *\n * ${today()}\n */\n\n${
        functions.join('\n')
    }\nexport { ${names.join(', ')} };\n`;
};
