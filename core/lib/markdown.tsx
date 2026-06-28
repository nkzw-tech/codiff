import { File as CodeFile } from '@pierre/diffs/react';
import type { ReactNode } from 'react';
import { markdownCodeBlockOptions } from './code-view-options.ts';

const renderText = (value: string, keyPrefix: string): Array<ReactNode> => {
  const textNodes: Array<ReactNode> = [];
  const emphasisPattern =
    /\*\*([^*\n]+)\*\*|(?<![\w_])_([^_\n]+)_(?![\w_])|(?<![\w*])\*([^*\n]+)\*(?![\w*])/g;
  let textLastIndex = 0;
  let emphasisMatch: RegExpExecArray | null;

  while ((emphasisMatch = emphasisPattern.exec(value))) {
    if (emphasisMatch.index > textLastIndex) {
      textNodes.push(value.slice(textLastIndex, emphasisMatch.index));
    }

    if (emphasisMatch[1] != null) {
      textNodes.push(
        <strong key={`${keyPrefix}:bold:${emphasisMatch.index}`}>{emphasisMatch[1]}</strong>,
      );
    } else {
      textNodes.push(
        <em key={`${keyPrefix}:italic:${emphasisMatch.index}`}>
          {emphasisMatch[2] ?? emphasisMatch[3]}
        </em>,
      );
    }
    textLastIndex = emphasisPattern.lastIndex;
  }

  if (textLastIndex < value.length) {
    textNodes.push(value.slice(textLastIndex));
  }

  return textNodes.length > 0 ? textNodes : [value];
};

const getSafeImageSource = (source: string) => {
  const trimmed = source.trim();

  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
};

const getHtmlAttribute = (html: string, name: string) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i').exec(
    html,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
};

const getImageDimension = (value: string) => (/^\d{1,5}$/.test(value) ? value : undefined);

const renderImage = (
  source: string,
  alt: string,
  key: string,
  dimensions: { height?: string; width?: string } = {},
) => {
  const safeSource = getSafeImageSource(source);
  if (!safeSource) {
    return null;
  }

  return (
    <img
      alt={alt}
      className="codiff-markdown-image"
      decoding="async"
      height={dimensions.height}
      key={key}
      loading="lazy"
      src={safeSource}
      width={dimensions.width}
    />
  );
};

export const renderInlineMarkdown = (text: string): ReactNode => {
  const nodes: Array<ReactNode> = [];
  const pattern =
    /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)|<img\b[^>]*>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(...renderText(text.slice(lastIndex, match.index), `${lastIndex}`));
    }

    if (match[1] != null) {
      nodes.push(
        <code className="walkthrough-inline-code" key={`${match.index}:${match[1]}`}>
          {match[1]}
        </code>,
      );
    } else {
      const htmlImage = match[0].startsWith('<');
      const src = htmlImage ? getHtmlAttribute(match[0], 'src') : (match[3] ?? '');
      const alt = htmlImage ? getHtmlAttribute(match[0], 'alt') : (match[2] ?? '');
      const image = htmlImage
        ? renderImage(src, alt, `image:${match.index}`, {
            height: getImageDimension(getHtmlAttribute(match[0], 'height')),
            width: getImageDimension(getHtmlAttribute(match[0], 'width')),
          })
        : renderImage(src, alt, `image:${match.index}`);
      if (image) {
        nodes.push(image);
      } else {
        nodes.push(...renderText(match[0], `${match.index}:image`));
      }
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(...renderText(text.slice(lastIndex), `${lastIndex}`));
  }

  return nodes.length > 0 ? nodes : text;
};

const markdownFenceLanguageAliases: Record<string, string> = {
  bash: 'bash',
  cjs: 'cjs',
  css: 'css',
  diff: 'diff',
  html: 'html',
  javascript: 'js',
  js: 'js',
  json: 'json',
  jsx: 'jsx',
  markdown: 'md',
  md: 'md',
  mjs: 'mjs',
  patch: 'patch',
  py: 'py',
  python: 'py',
  rb: 'rb',
  ruby: 'rb',
  sh: 'sh',
  shell: 'sh',
  ts: 'ts',
  tsx: 'tsx',
  typescript: 'ts',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yml',
  zsh: 'zsh',
};

const getMarkdownFenceFileName = (info: string) => {
  const language = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!language) {
    return 'snippet.txt';
  }

  const extension = markdownFenceLanguageAliases[language] ?? language.replaceAll(/[^\w+#.-]/g, '');
  return extension ? `snippet.${extension}` : 'snippet.txt';
};

function MarkdownCodeBlock({
  added,
  code,
  highlighted,
  info,
}: {
  added: boolean;
  code: string;
  highlighted: boolean;
  info: string;
}) {
  const codeBlock = highlighted ? (
    <CodeFile
      className="codiff-markdown-code-block"
      disableWorkerPool={false}
      file={{
        cacheKey: `markdown-code:${info}:${code.length}:${code.slice(0, 64)}`,
        contents: code,
        name: getMarkdownFenceFileName(info),
      }}
      options={markdownCodeBlockOptions}
    />
  ) : (
    <pre>
      <code>{code}</code>
    </pre>
  );

  return added ? (
    <div className="codiff-markdown-code-added codiff-markdown-added">{codeBlock}</div>
  ) : (
    codeBlock
  );
}

const getLineStarts = (text: string) => {
  const starts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }

  return starts;
};

const getLineNumberAtIndex = (lineStarts: ReadonlyArray<number>, index: number) => {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = lineStarts[middle] ?? 0;
    const nextStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (index < start) {
      high = middle - 1;
    } else if (index >= nextStart) {
      low = middle + 1;
    } else {
      return middle + 1;
    }
  }

  return lineStarts.length;
};

const hasAddedLineInRange = (
  addedLines: ReadonlySet<number> | undefined,
  startLine: number,
  endLine: number,
) => {
  if (!addedLines?.size) {
    return false;
  }

  for (const line of addedLines) {
    if (line >= startLine && line <= endLine) {
      return true;
    }
  }

  return false;
};

const getBlockClassName = (added: boolean) => (added ? 'codiff-markdown-added' : undefined);

export const renderMarkdown = (
  text: string,
  {
    addedLines,
    highlightCode = false,
  }: { addedLines?: ReadonlySet<number>; highlightCode?: boolean } = {},
): ReactNode => {
  const blocks: Array<ReactNode> = [];
  const lineStarts = getLineStarts(text);
  const isAddedSourceRange = (startIndex: number, endIndex: number) =>
    hasAddedLineInRange(
      addedLines,
      getLineNumberAtIndex(lineStarts, startIndex),
      getLineNumberAtIndex(lineStarts, Math.max(startIndex, endIndex)),
    );

  const renderTextBlocks = (value: string, keyPrefix: string, sourceOffset: number) => {
    let blockStart = 0;
    let index = 0;
    const separatorPattern = /\n{2,}/g;
    let separator: RegExpExecArray | null;

    const renderTextBlock = (rawBlock: string, rawBlockOffset: number) => {
      const block = rawBlock.trim();
      if (!block) {
        return;
      }

      const leadingWhitespaceLength = rawBlock.search(/\S/);
      const blockStartIndex = rawBlockOffset + Math.max(0, leadingWhitespaceLength);
      const blockEndIndex = blockStartIndex + block.length - 1;
      const className = getBlockClassName(isAddedSourceRange(blockStartIndex, blockEndIndex));
      const lines = block.split('\n');
      const heading = lines.length === 1 ? lines[0]?.match(/^(#{1,6})\s+(.+)$/) : null;
      const listItems = lines
        .map((line) => line.trim().match(/^[-*]\s+(.+)$/)?.[1])
        .filter((line): line is string => line != null);
      const orderedListItems = lines
        .map((line) => line.trim().match(/^\d+\.\s+(.+)$/)?.[1])
        .filter((line): line is string => line != null);
      const quoteLines = lines
        .map((line) => line.trim().match(/^>\s?(.*)$/)?.[1])
        .filter((line): line is string => line != null);

      if (heading) {
        const headingContent = renderInlineMarkdown(heading[2]);
        const key = `${keyPrefix}:h:${index}`;
        switch (heading[1].length) {
          case 1:
            blocks.push(
              <h1 className={className} key={key}>
                {headingContent}
              </h1>,
            );
            break;
          case 2:
            blocks.push(
              <h2 className={className} key={key}>
                {headingContent}
              </h2>,
            );
            break;
          case 3:
            blocks.push(
              <h3 className={className} key={key}>
                {headingContent}
              </h3>,
            );
            break;
          case 4:
            blocks.push(
              <h4 className={className} key={key}>
                {headingContent}
              </h4>,
            );
            break;
          case 5:
            blocks.push(
              <h5 className={className} key={key}>
                {headingContent}
              </h5>,
            );
            break;
          default:
            blocks.push(
              <h6 className={className} key={key}>
                {headingContent}
              </h6>,
            );
            break;
        }
      } else if (listItems.length === lines.length) {
        blocks.push(
          <ul className={className} key={`${keyPrefix}:list:${index}`}>
            {listItems.map((line, lineIndex) => (
              <li key={`${keyPrefix}:list:${index}:${lineIndex}`}>{renderInlineMarkdown(line)}</li>
            ))}
          </ul>,
        );
      } else if (orderedListItems.length === lines.length) {
        blocks.push(
          <ol className={className} key={`${keyPrefix}:ordered-list:${index}`}>
            {orderedListItems.map((line, lineIndex) => (
              <li key={`${keyPrefix}:ordered-list:${index}:${lineIndex}`}>
                {renderInlineMarkdown(line)}
              </li>
            ))}
          </ol>,
        );
      } else if (quoteLines.length === lines.length) {
        blocks.push(
          <blockquote className={className} key={`${keyPrefix}:quote:${index}`}>
            {quoteLines.map((line, lineIndex) => (
              <span key={`${keyPrefix}:quote:${index}:${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {renderInlineMarkdown(line)}
              </span>
            ))}
          </blockquote>,
        );
      } else if (lines.length === 1 && /^(?:-{3,}|\*{3,}|_{3,})$/.test(lines[0].trim())) {
        blocks.push(<hr className={className} key={`${keyPrefix}:hr:${index}`} />);
      } else {
        const paragraphText = lines.map((line) => line.trim()).join(' ');
        blocks.push(
          <p className={className} key={`${keyPrefix}:p:${index}`}>
            {renderInlineMarkdown(paragraphText)}
          </p>,
        );
      }

      index += 1;
    };

    while ((separator = separatorPattern.exec(value))) {
      renderTextBlock(value.slice(blockStart, separator.index), sourceOffset + blockStart);
      blockStart = separator.index + separator[0].length;
    }

    renderTextBlock(value.slice(blockStart), sourceOffset + blockStart);
  };

  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(text))) {
    if (match.index > lastIndex) {
      renderTextBlocks(text.slice(lastIndex, match.index), `${lastIndex}`, lastIndex);
    }

    blocks.push(
      <MarkdownCodeBlock
        added={isAddedSourceRange(match.index, fencePattern.lastIndex - 1)}
        code={match[2]}
        highlighted={highlightCode}
        info={match[1]}
        key={`code:${match.index}`}
      />,
    );
    lastIndex = fencePattern.lastIndex;
  }

  if (lastIndex < text.length) {
    renderTextBlocks(text.slice(lastIndex), `${lastIndex}`, lastIndex);
  }

  return blocks.length > 0 ? blocks : renderInlineMarkdown(text);
};
