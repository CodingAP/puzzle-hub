/**
 * frontend/src/wisdom.ts
 *
 * now and then one of the snowflakes (or bubbles) turns golden; pop it for a bit of wisdom across the top
 */

import { h } from './dom.ts';

const WISDOM = [
    'read the whole puzzle before you write a single line.',
    'the example input is your best friend. test against it first.',
    'off-by-one errors are the oldest bugs in the book, and they are still in the book.',
    'when part two arrives, the brute force you wrote for part one will be judged.',
    'a good data structure turns a hard problem into an easy loop.',
    'if it takes longer than a minute to run, there is probably a trick.',
    'cycles repeat. find the cycle, skip the billions.',
    'print it out. looking at the data beats guessing about it.',
    'simple and correct beats clever and wrong.',
    'when in doubt, breadth-first search.',
    'memoise the recursion and watch the impossible become instant.',
    'the input is always weirder than the example.',
    'take a break. the answer often shows up in the shower.',
    'a wrong answer is still information.',
    'name your variables like you will read this code next december.',
    'parse first, solve second. most bugs live in the parser.',
    'every grid is a graph if you squint.',
    'the leaderboard is fast; your understanding should be deep.',
    'start with the dumbest thing that could possibly work.',
    'modular arithmetic: when the numbers get too big, they get smaller.',
    'not every puzzle needs to be solved today. it will still be there tomorrow.',
    'the bug is never where you are looking. look somewhere else.',
    'one star is still a star.',
    'write it so part two is a small change, not a rewrite.',
    'patience solves more puzzles than speed.',
];

/** the odds that a flake starting another trip down the screen comes back golden (only one is golden at a time) */
const GOLDEN_CHANCE = 1 / 400;
const BANNER_MS = 10_000;

let lastQuote = -1;
let bannerTimer: number | undefined;

const pickQuote = () => {
    let index = Math.floor(Math.random() * WISDOM.length);
    if (index === lastQuote) index = (index + 1) % WISDOM.length;
    lastQuote = index;
    return WISDOM[index];
};

const showBanner = (text: string) => {
    document.querySelector('#wisdom-banner')?.remove();
    clearTimeout(bannerTimer);
    const banner = h(
        'div',
        { id: 'wisdom-banner', role: 'status', title: 'click to dismiss', onClick: () => banner.remove() },
        h('span', { className: 'wisdom-glyph' }, '✦'),
        h('span', { className: 'wisdom-text' }, text),
        h('span', { className: 'wisdom-glyph' }, '✦'),
        h('div', { className: 'wisdom-timer', style: `animation-duration: ${BANNER_MS}ms` }),
    );
    document.body.append(banner);
    bannerTimer = setTimeout(() => {
        banner.classList.add('leaving');
        setTimeout(() => banner.remove(), 400);
    }, BANNER_MS);
};

const burst = (x: number, y: number) => {
    const sparks = Array.from({ length: 10 }, (_, i) => {
        const angle = (i / 10) * Math.PI * 2;
        return h('span', { className: 'wisdom-spark', style: `--dx: ${Math.cos(angle) * 40}px; --dy: ${Math.sin(angle) * 40}px` });
    });
    const element = h('div', { className: 'wisdom-burst', style: `left: ${x}px; top: ${y}px` }, sparks);
    document.body.append(element);
    setTimeout(() => element.remove(), 700);
};

const pop = (flake: HTMLElement, event: MouseEvent) => {
    flake.classList.remove('golden');
    // hidden until it loops back around, so it doesn't reappear mid-screen as a plain flake
    flake.classList.add('popped');
    burst(event.clientX, event.clientY);
    showBanner(pickQuote());
};

/**
 * hooks the golden-flake roll into the overlay; safe to call once, survives the flakes being re-rendered
 */
export const initWisdom = (container: HTMLElement) => {
    container.addEventListener('animationiteration', (event) => {
        const flake = event.target as HTMLElement;
        if (!flake.classList?.contains('snowflake')) return;
        flake.classList.remove('popped');
        if (flake.classList.contains('golden')) {
            flake.classList.remove('golden');
            return;
        }
        if (Math.random() < GOLDEN_CHANCE && !container.querySelector('.golden')) flake.classList.add('golden');
    });
    container.addEventListener('click', (event) => {
        const flake = (event.target as HTMLElement).closest<HTMLElement>('.snowflake.golden');
        if (flake) pop(flake, event);
    });
};
