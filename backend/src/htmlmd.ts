/**
 * backend/src/htmlmd.ts
 *
 * turns the simple html puzzle sites serve into markdown, shared by every provider
 */

import { elementChildren, type ElementNode, type HtmlNode } from './html.ts';

const collapse = (text: string) => text.replace(/\s+/g, ' ');

/** containers whose whitespace-only text children are just formatting */
const BLOCK_TAGS = new Set(['#root', 'html', 'body', 'main', 'article', 'section', 'div']);

/**
 * converts a node to markdown; relative links are resolved against baseUrl
 */
export const toMarkdown = (node: HtmlNode, baseUrl: string, inPre = false): string => {
    if (node.type === 'text') return inPre ? node.text : collapse(node.text);

    const isBlock = BLOCK_TAGS.has(node.tag);
    const children = (pre = inPre) =>
        node.children
            .filter((child) => !(isBlock && child.type === 'text' && child.text.trim() === ''))
            .map((child) => toMarkdown(child, baseUrl, pre))
            .join('');

    // inside code, markdown has no markup: emphasis (sites highlight the characters that matter) becomes ⟪…⟫ markers
    // that the hub's renderer turns back into <em>; everything else is plain text
    if (inPre && node.tag !== 'pre') {
        if (node.tag === 'em' || node.tag === 'strong' || node.tag === 'b') return `⟪${children(true)}⟫`;
        return children(true);
    }

    switch (node.tag) {
        case 'h1':
        case 'h2':
            return `## ${children().trim()}\n\n`;
        case 'h3':
        case 'h4':
            return `### ${children().trim()}\n\n`;
        case 'p':
            return `${children().trim()}\n\n`;
        case 'pre':
            return `\`\`\`\n${children(true).replace(/\n$/, '')}\n\`\`\`\n\n`;
        case 'code': {
            const text = children(true); // nested emphasis becomes a ⟪…⟫ marker, see above
            return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
        }
        case 'em':
        case 'i':
            return (node as ElementNode).attributes.class === 'star' ? `**${children()}**` : `*${children()}*`;
        case 'strong':
        case 'b':
            return `**${children()}**`;
        case 'a': {
            const href = node.attributes.href ?? '';
            const url = /^https?:/.test(href) ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
            return `[${children()}](${url})`;
        }
        case 'ul':
        case 'ol':
            return elementChildren(node)
                .filter((child) => child.tag === 'li')
                .map((child, index) => `${node.tag === 'ol' ? `${index + 1}.` : '-'} ${toMarkdown(child, baseUrl).trim()}\n`)
                .join('') + '\n';
        case 'span': {
            const title = node.attributes.title;
            return title ? `${children()} (${collapse(title)})` : children();
        }
        case 'br':
            return '\n';
        case 'form':
        case 'script':
        case 'style':
        case 'nav':
        case 'header':
        case 'footer':
            return '';
        default:
            return children();
    }
};
