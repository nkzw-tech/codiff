import { MarkdownEditor } from '@nkzw/mdx-editor';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { Copy as LucideCopy } from 'lucide-react';
import type { ComponentProps, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Suspense, useCallback, useMemo } from 'react';
import { renderInlineMarkdown } from '../../lib/markdown.tsx';
import { useCopiedState } from './useCopiedState.ts';

type MarkdownEditorProps = ComponentProps<typeof MarkdownEditor>;

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

const detailsBlockPattern =
  /<details\b([^>]*)>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
const htmlCommentPattern = /<!--[\s\S]*?-->/g;

const hasOpenAttribute = (attributes: string) =>
  /(?:^|\s)open(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?:\s|$)/i.test(attributes);
const stripHtmlComments = (value: string) => value.replaceAll(htmlCommentPattern, '');
const getFenceMarker = (line: string) => {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
  return match?.[1] ?? null;
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
    const currentFenceMarker = getFenceMarker(line);

    if (fenceMarker) {
      normalizedLines.push(line);
      if (
        currentFenceMarker?.startsWith(fenceMarker[0]!) &&
        currentFenceMarker.length >= fenceMarker.length
      ) {
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

    if (currentFenceMarker) {
      fenceMarker = currentFenceMarker;
    }
  }

  const normalizedValue = normalizedLines.join('\n');
  return preserveSingleTrailingNewline && normalizedValue
    ? `${normalizedValue}\n`
    : normalizedValue;
};

const isClosingFence = (marker: string, candidate: string | null) =>
  candidate != null && candidate[0] === marker[0] && candidate.length >= marker.length;

export const extractFencedCodeBlocks = (value: string): Array<string> => {
  const blocks: Array<string> = [];
  let fenceMarker: string | null = null;
  let currentBlock: Array<string> = [];

  for (const line of value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    const currentFenceMarker = getFenceMarker(line);

    if (fenceMarker) {
      if (isClosingFence(fenceMarker, currentFenceMarker)) {
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
        fenceMarker = null;
        continue;
      }
      currentBlock.push(line);
      continue;
    }

    if (currentFenceMarker) {
      fenceMarker = currentFenceMarker;
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
  let match: RegExpExecArray | null;

  while ((match = detailsBlockPattern.exec(value))) {
    if (match.index > lastIndex) {
      parts.push({ type: 'markdown', value: value.slice(lastIndex, match.index) });
    }

    parts.push({
      body: match[3] ?? '',
      open: hasOpenAttribute(match[1] ?? ''),
      summary: stripHtmlComments(match[2] ?? '').trim(),
      type: 'details',
    });
    lastIndex = detailsBlockPattern.lastIndex;
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

function CopyCodeButton({ code }: { code: string }) {
  const [copied, markCopied] = useCopiedState(1600);

  const handleClick = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      // The button lives inside `<summary>`, which would otherwise toggle.
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        return;
      }
      markCopied();
    },
    [code, markCopied],
  );

  const label = copied ? 'Code copied' : 'Copy code';

  return (
    <button
      aria-label={label}
      className={`codiff-copy-path-button codiff-copy-code-button${copied ? ' copied' : ''}`}
      onClick={(event) => void handleClick(event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation();
        }
      }}
      title={label}
      type="button"
    >
      {copied ? (
        <Check aria-hidden className="codiff-copy-path-icon check" size={16} weight="bold" />
      ) : (
        <LucideCopy aria-hidden className="codiff-copy-path-icon" size={16} strokeWidth={2.25} />
      )}
    </button>
  );
}

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
