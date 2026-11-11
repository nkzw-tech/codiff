import type { Html, Root, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';

const attachmentUrlPattern =
  /^https:\/\/github\.com\/(?:user-attachments\/assets|[\w.-]+\/[\w.-]+\/assets\/\d+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const getGitHubAttachmentId = (source: string) =>
  attachmentUrlPattern.exec(source)?.[1].toLowerCase();

const encodeMarkdownText = (value: string) =>
  value.replaceAll(/[^\p{L}\p{N} ]/gu, (character) => `&#${character.codePointAt(0)};`);

// The read-only renderer suppresses raw HTML. Import only the fields needed
// for a Markdown image, from an inert template that never loads the image.
const readHtmlAttachmentImage = (html: string, assetUrls: Readonly<Record<string, string>>) => {
  if (!/^<img\s/i.test(html)) {
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = html.trimEnd();
  const image = template.content.firstElementChild;
  if (image?.localName !== 'img' || template.content.childNodes.length !== 1) {
    return;
  }
  const source = image.getAttribute('src')?.trim() ?? '';
  const id = getGitHubAttachmentId(source);
  if (!id || !assetUrls[id]) {
    return;
  }
  const alt = encodeMarkdownText(image.getAttribute('alt') ?? '');
  const title = image.getAttribute('title');
  const dimensions = ['width', 'height'].flatMap((name) => {
    const value = image.getAttribute(name);
    return value && /^\d{1,5}$/.test(value) ? [`${name}=${value}`] : [];
  });
  return `![${alt}](${source}${title ? ` "${encodeMarkdownText(title)}"` : ''})${dimensions.length ? `{${dimensions.join(' ')}}` : ''}`;
};

// Convert attachment markup to Markdown images with the original URLs.
// The image renderer resolves the signed URL only when loading the media.
export function embedGitHubAttachments(
  markdown: string,
  assetUrls: Readonly<Record<string, string>>,
): string {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm(), frontmatter(['yaml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])],
  });
  const lines = markdown.split(/\r\n?|\n/);
  const parts: Array<string> = [];
  let offset = 0;

  const replace = (start: number, end: number, replacement: string) => {
    parts.push(markdown.slice(offset, start), replacement);
    offset = end;
  };
  const visitHtml = (node: Html) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const image = readHtmlAttachmentImage(node.value, assetUrls);
    if (image && start != null && end != null) {
      replace(start, end, image);
    }
  };
  const visit = (node: Root | RootContent) => {
    if (node.type === 'paragraph') {
      for (const child of node.children) {
        if (child.type === 'html') {
          visitHtml(child);
        }
        if (child.type !== 'link' || !child.position) {
          continue;
        }
        const { end, start } = child.position;
        const startOffset = start.offset;
        const endOffset = end.offset;
        const id = getGitHubAttachmentId(child.url);
        if (
          id &&
          assetUrls[id] &&
          startOffset != null &&
          endOffset != null &&
          markdown.slice(startOffset, endOffset) === child.url &&
          (node.position?.start.offset === startOffset ||
            !lines[start.line - 1].slice(0, start.column - 1).trim()) &&
          !lines[end.line - 1].slice(end.column - 1).trim()
        ) {
          replace(startOffset, endOffset, `![](${child.url})`);
        }
      }
    } else if (node.type === 'html') {
      visitHtml(node);
    } else if (
      node.type === 'root' ||
      node.type === 'blockquote' ||
      node.type === 'list' ||
      node.type === 'listItem'
    ) {
      node.children.forEach(visit);
    }
  };

  visit(tree);
  return parts.length ? parts.join('') + markdown.slice(offset) : markdown;
}
