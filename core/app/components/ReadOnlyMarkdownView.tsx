import type { MarkdownEditor as MarkdownEditorComponent } from '@nkzw/mdx-editor';
import type { ComponentProps, ReactNode } from 'react';
import { Suspense, useMemo } from 'react';
import { renderInlineMarkdown } from '../../lib/markdown.tsx';
import { CopyCodeButton } from './CopyCodeButton.tsx';
import { MarkdownEditor } from './LazyMarkdownEditor.tsx';

type MarkdownEditorProps = ComponentProps<typeof MarkdownEditorComponent>;

type MarkdownDetailsPart = {
  body: string;
  open: boolean;
  summary: string;
  type: 'details';
};

type MarkdownTextPart = {
  type: 'markdown';
  value: string;
};

type MarkdownPart = MarkdownDetailsPart | MarkdownTextPart;

const htmlCommentPattern = /<!--[\s\S]*?-->/g;
const detailsOpenPattern = /<details\b([^>]*)>/gi;
const detailsTagPattern = /<\/?details\b[^>]*>/gi;
const summaryOpenPattern = /^\s*<summary\b[^>]*>/i;
const summaryClosePattern = /<\/summary>/gi;

const hasOpenAttribute = (attributes: string) =>
  /(?:^|\s)open(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?:\s|$)/i.test(attributes);
const stripHtmlComments = (value: string) => value.replaceAll(htmlCommentPattern, '');
const getOpeningFenceMarker = (line: string) => {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
  const marker = match?.[1] ?? null;
  if (!marker || (marker[0] === '`' && line.slice(match![0].length).includes('`'))) {
    return null;
  }
  return marker;
};

const isClosingFence = (marker: string, line: string) => {
  const candidate = /^(?: {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1] ?? null;
  return candidate != null && candidate[0] === marker[0] && candidate.length >= marker.length;
};

export const normalizeReadOnlyMarkdownValue = (value: string) => {
  const normalizedLineEndings = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const preserveSingleTrailingNewline =
    /\n$/.test(normalizedLineEndings) && !/\n[ \t]*\n[ \t]*$/.test(normalizedLineEndings);
  const lines = normalizedLineEndings.split('\n');
  const normalizedLines: Array<string> = [];
  let pendingBlankLine = false;
  let fenceMarker: string | null = null;

  for (const line of lines) {
    if (fenceMarker) {
      normalizedLines.push(line);
      if (isClosingFence(fenceMarker, line)) {
        fenceMarker = null;
      }
      continue;
    }

    if (!line.trim()) {
      pendingBlankLine = true;
      continue;
    }

    if (pendingBlankLine && normalizedLines.length > 0) {
      normalizedLines.push('');
    }
    pendingBlankLine = false;
    normalizedLines.push(line);

    const openingFenceMarker = getOpeningFenceMarker(line);
    if (openingFenceMarker) {
      fenceMarker = openingFenceMarker;
    }
  }

  const normalizedValue = normalizedLines.join('\n');
  return preserveSingleTrailingNewline && normalizedValue
    ? `${normalizedValue}\n`
    : normalizedValue;
};

export const extractFencedCodeBlocks = (value: string): Array<string> => {
  const blocks: Array<string> = [];
  let fenceMarker: string | null = null;
  let currentBlock: Array<string> = [];

  for (const line of value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    if (fenceMarker) {
      if (isClosingFence(fenceMarker, line)) {
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
        fenceMarker = null;
        continue;
      }
      currentBlock.push(line);
      continue;
    }

    const openingFenceMarker = getOpeningFenceMarker(line);
    if (openingFenceMarker) {
      fenceMarker = openingFenceMarker;
    }
  }

  // An unterminated fence still renders as a code block, so it stays copyable.
  // Its trailing newline has no closing fence to belong to, so it is dropped.
  while (fenceMarker && currentBlock.at(-1) === '') {
    currentBlock.pop();
  }
  if (fenceMarker && currentBlock.length > 0) {
    blocks.push(currentBlock.join('\n'));
  }

  return blocks.filter((block) => block.trim().length > 0);
};

const parseMarkdownDetails = (value: string): Array<MarkdownPart> => {
  const parts: Array<MarkdownPart> = [];
  let lastIndex = 0;
  let searchIndex = 0;

  while (searchIndex < value.length) {
    detailsOpenPattern.lastIndex = searchIndex;
    const detailsOpen = detailsOpenPattern.exec(value);
    if (!detailsOpen) {
      break;
    }

    const detailsBodyStart = detailsOpenPattern.lastIndex;
    const summaryOpen = summaryOpenPattern.exec(value.slice(detailsBodyStart));
    if (!summaryOpen) {
      searchIndex = detailsBodyStart;
      continue;
    }

    const summaryStart = detailsBodyStart + summaryOpen[0].length;
    summaryClosePattern.lastIndex = summaryStart;
    const summaryClose = summaryClosePattern.exec(value);
    if (!summaryClose) {
      searchIndex = detailsBodyStart;
      continue;
    }

    const bodyStart = summaryClosePattern.lastIndex;
    detailsTagPattern.lastIndex = bodyStart;
    let depth = 1;
    let detailsClose: RegExpExecArray | null = null;
    while (depth > 0) {
      const tag = detailsTagPattern.exec(value);
      if (!tag) {
        break;
      }
      if (/^<\/details\b/i.test(tag[0])) {
        depth -= 1;
        if (depth === 0) {
          detailsClose = tag;
        }
      } else {
        depth += 1;
      }
    }

    if (!detailsClose) {
      searchIndex = detailsBodyStart;
      continue;
    }

    if (detailsOpen.index > lastIndex) {
      parts.push({ type: 'markdown', value: value.slice(lastIndex, detailsOpen.index) });
    }
    parts.push({
      body: value.slice(bodyStart, detailsClose.index),
      open: hasOpenAttribute(detailsOpen[1] ?? ''),
      summary: stripHtmlComments(value.slice(summaryStart, summaryClose.index)).trim(),
      type: 'details',
    });
    lastIndex = detailsTagPattern.lastIndex;
    searchIndex = lastIndex;
  }

  if (lastIndex < value.length) {
    parts.push({ type: 'markdown', value: value.slice(lastIndex) });
  }

  return parts;
};

const hasDetailsBlock = (parts: ReadonlyArray<MarkdownPart>) =>
  parts.some((part) => part.type === 'details');

// Nested `<details>` render their own button, so only this level's code is copied.
const getOwnFencedCode = (parts: ReadonlyArray<MarkdownPart>) =>
  parts
    .filter((part) => part.type === 'markdown')
    .flatMap((part) => extractFencedCodeBlocks(part.value))
    .join('\n\n');

function MarkdownSegment({
  additionalPlugins,
  ariaLabel,
  contentClassName,
  editorClassName,
  onHeightChange,
  value,
}: {
  additionalPlugins?: MarkdownEditorProps['additionalPlugins'];
  ariaLabel: string;
  contentClassName?: string;
  editorClassName?: string;
  onHeightChange?: (height: number) => void;
  value: string;
}) {
  const normalizedValue = normalizeReadOnlyMarkdownValue(value);
  if (!normalizedValue.trim()) {
    return null;
  }

  return (
    <div className="codiff-safe-markdown-segment">
      <MarkdownEditor
        additionalPlugins={additionalPlugins}
        ariaLabel={ariaLabel}
        className={`codiff-readonly-markdown-editor${editorClassName ? ` ${editorClassName}` : ''}`}
        colorScheme="inherit"
        contentClassName={contentClassName}
        density="compact"
        onHeightChange={onHeightChange}
        readOnly
        renderDiagrams
        spellCheck={false}
        suppressHtmlProcessing
        value={normalizedValue}
        variant="embedded"
      />
    </div>
  );
}

function MarkdownParts({
  additionalPlugins,
  ariaLabel,
  contentClassName,
  editorClassName,
  onHeightChange,
  parts,
}: {
  additionalPlugins?: MarkdownEditorProps['additionalPlugins'];
  ariaLabel: string;
  contentClassName?: string;
  editorClassName?: string;
  onHeightChange?: (height: number) => void;
  parts: ReadonlyArray<MarkdownPart>;
}) {
  return parts.map((part, index) => {
    if (part.type === 'markdown') {
      return (
        <MarkdownSegment
          additionalPlugins={additionalPlugins}
          ariaLabel={ariaLabel}
          contentClassName={contentClassName}
          editorClassName={editorClassName}
          key={`markdown:${index}`}
          onHeightChange={onHeightChange}
          value={part.value}
        />
      );
    }

    const bodyParts = parseMarkdownDetails(part.body);
    const code = getOwnFencedCode(bodyParts);

    return (
      <details
        className="codiff-markdown-details"
        key={`details:${index}`}
        onToggle={(event) => onHeightChange?.(event.currentTarget.getBoundingClientRect().height)}
        open={part.open}
      >
        <summary>
          <span className="codiff-markdown-details-summary-label">
            {renderInlineMarkdown(part.summary || 'Details')}
          </span>
          {code ? <CopyCodeButton code={code} /> : null}
        </summary>
        <MarkdownParts
          additionalPlugins={additionalPlugins}
          ariaLabel={`${ariaLabel} details`}
          contentClassName={contentClassName}
          editorClassName={editorClassName}
          onHeightChange={onHeightChange}
          parts={bodyParts}
        />
      </details>
    );
  });
}

export function ReadOnlyMarkdownView({
  additionalPlugins,
  ariaLabel,
  className,
  contentClassName,
  density = 'document',
  fallback,
  onHeightChange,
  value,
  variant = 'plain',
}: {
  additionalPlugins?: MarkdownEditorProps['additionalPlugins'];
  ariaLabel: string;
  className: string;
  contentClassName?: string;
  density?: MarkdownEditorProps['density'];
  fallback?: ReactNode;
  onHeightChange?: (height: number) => void;
  value: string;
  variant?: MarkdownEditorProps['variant'];
}) {
  const normalizedValue = useMemo(() => normalizeReadOnlyMarkdownValue(value), [value]);
  const parts = useMemo(() => parseMarkdownDetails(normalizedValue), [normalizedValue]);

  if (!hasDetailsBlock(parts)) {
    if (!normalizedValue.trim()) {
      return null;
    }

    return (
      <Suspense
        fallback={
          fallback ?? (
            <div className={`${className} codiff-readonly-markdown-loading`}>Loading…</div>
          )
        }
      >
        <div className={className}>
          <MarkdownEditor
            additionalPlugins={additionalPlugins}
            ariaLabel={ariaLabel}
            className={`codiff-readonly-markdown-editor ${className}`}
            colorScheme="inherit"
            contentClassName={contentClassName}
            density={density}
            onHeightChange={onHeightChange}
            readOnly
            renderDiagrams
            spellCheck={false}
            suppressHtmlProcessing
            value={normalizedValue}
            variant={variant}
          />
        </div>
      </Suspense>
    );
  }

  return (
    <Suspense
      fallback={
        fallback ?? <div className={`${className} codiff-readonly-markdown-loading`}>Loading…</div>
      }
    >
      <div aria-label={ariaLabel} className={`${className} codiff-safe-markdown-view`}>
        <MarkdownParts
          additionalPlugins={additionalPlugins}
          ariaLabel={ariaLabel}
          contentClassName={contentClassName}
          editorClassName={className}
          onHeightChange={onHeightChange}
          parts={parts}
        />
      </div>
    </Suspense>
  );
}
