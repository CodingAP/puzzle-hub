/**
 * frontend/src/sanitize.ts
 *
 * puzzle text that keeps a site's own markup is rebuilt from an allow list before it is shown: only known tags and
 * attributes survive, so nothing in it can run code, load anything, or restyle the app.
 */

const HTML_TAGS = new Set([
    'a',
    'b',
    'blockquote',
    'br',
    'code',
    'div',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'li',
    'ol',
    'p',
    'pre',
    'section',
    'small',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
]);

/** drawing elements; kept with their svg namespace */
const SVG_TAGS = new Set([
    'svg',
    'g',
    'path',
    'circle',
    'ellipse',
    'rect',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'defs',
    'marker',
    'clipPath',
    'title',
]);

const ATTRIBUTES = new Set([
    'class',
    'title',
    'colspan',
    'rowspan',
    'data-part',
    // geometry and paint of drawings
    'viewBox',
    'width',
    'height',
    'd',
    'fill',
    'fill-rule',
    'fill-opacity',
    'stroke',
    'stroke-width',
    'stroke-dasharray',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-opacity',
    'opacity',
    'transform',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'dx',
    'dy',
    'points',
    'font-family',
    'font-size',
    'font-weight',
    'text-anchor',
    'dominant-baseline',
    'markerWidth',
    'markerHeight',
    'orient',
    'refX',
    'refY',
    'preserveAspectRatio',
    'overflow',
]);

/** attributes whose value may only point inside the same drawing: url(#id) */
const LOCAL_REFERENCES = new Set(['clip-path', 'marker-start', 'marker-mid', 'marker-end']);

const SVG_NS = 'http://www.w3.org/2000/svg';

/** an inline style survives only when it cannot fetch anything or move the element out of the text */
const safeStyle = (style: string): string | null => (/url\s*\(|expression|@import|position|javascript|behavior|-moz-binding/i.test(style) ? null : style);

let drawings = 0;

const copy = (node: Node, target: Node, ids: Map<string, string>): void => {
    if (node.nodeType === Node.TEXT_NODE) {
        target.appendChild(document.createTextNode(node.textContent ?? ''));
        return;
    }
    if (!(node instanceof Element)) return;

    const svg = node.namespaceURI === SVG_NS;
    const tag = svg ? node.localName : node.localName.toLowerCase();
    if (!(svg ? SVG_TAGS : HTML_TAGS).has(tag)) {
        // unknown wrappers are unwrapped; anything that could carry code or load something is dropped with its contents
        if (!['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'foreignobject', 'img', 'video', 'audio'].includes(tag.toLowerCase())) {
            for (const child of node.childNodes) copy(child, target, ids);
        }
        return;
    }

    // ids are only meaningful inside one drawing; each drawing gets its own prefix so they cannot collide
    const scope = tag === 'svg' ? new Map<string, string>() : ids;
    const prefix = tag === 'svg' ? `drawing${++drawings}-` : '';
    if (tag === 'svg') { for (const element of node.querySelectorAll('[id]')) scope.set(element.id, prefix + element.id); }

    const element = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    for (const { name, value } of node.attributes) {
        if (ATTRIBUTES.has(name)) element.setAttribute(name, value);
        else if (name === 'id' && scope.has(value)) element.setAttribute('id', scope.get(value)!);
        else if (name === 'style') {
            const style = safeStyle(value);
            if (style) element.setAttribute('style', style);
        } else if (LOCAL_REFERENCES.has(name)) {
            const id = value.match(/^url\(#([^)]+)\)$/)?.[1];
            if (id && scope.has(id)) element.setAttribute(name, `url(#${scope.get(id)})`);
        } else if (name === 'href' && tag === 'a' && /^https?:\/\//i.test(value)) {
            element.setAttribute('href', value);
            element.setAttribute('target', '_blank');
            element.setAttribute('rel', 'noopener noreferrer');
        }
    }
    for (const child of node.childNodes) copy(child, element, scope);
    target.appendChild(element);
};

/**
 * the given markup as a document fragment that is safe to insert
 */
export const sanitizeHtml = (html: string): DocumentFragment => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const fragment = document.createDocumentFragment();
    for (const child of parsed.body.childNodes) copy(child, fragment, new Map());
    return fragment;
};
