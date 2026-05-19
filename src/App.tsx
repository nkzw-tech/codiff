import {
  parseDiffFromFile,
  parsePatchFiles,
  registerCustomTheme,
  type DiffLineAnnotation,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type FileDiffMetadata,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, WorkerPoolContextProvider } from '@pierre/diffs/react';
import type { FileTreeRowDecorationRenderer } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import {
  useCallback,
  useEffect,
  Fragment,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import codexIconUrl from './assets/codex.svg';
import dunkelTheme from './themes/dunkel.json' with { type: 'json' };
import lichtTheme from './themes/licht.json' with { type: 'json' };
import type {
  ChangedFile,
  CodiffLaunchOptions,
  CodiffPreferences,
  DiffSection,
  GitIdentity,
  GitFileStatus,
  HistoryEntry,
  RepositoryState,
  ReviewAssistantRequest,
  Walkthrough,
  ReviewSource,
  PullRequestExistingReviewComment,
  PullRequestReviewEvent,
  TerminalHelperStatus,
} from './types.ts';

type ReviewAnnotationMetadata = {
  commentIds: ReadonlyArray<string>;
};

type CodeViewInstance = NonNullable<
  ReturnType<CodeViewHandle<ReviewAnnotationMetadata>['getInstance']>
>;

const isInteractiveReviewEvent = (event: PointerEvent) =>
  event.composedPath().some(
    (target) =>
      // oxlint-disable-next-line @nkzw/no-instanceof
      target instanceof HTMLElement &&
      (target.closest('button, textarea, input, select, a') ||
        target.closest('.review-comment-thread')),
  );

const getReviewCommentLineSelection = (comment: ReviewComment): CodeViewLineSelection => ({
  id: `diff:${comment.sectionId}`,
  range: {
    end: comment.lineNumber,
    ...(comment.startSide != null && comment.startSide !== comment.side
      ? { endSide: comment.side }
      : {}),
    side: comment.startSide ?? comment.side,
    start: comment.startLineNumber ?? comment.lineNumber,
  },
});

type ReviewPatchRow = {
  additionLineNumber?: number;
  deletionLineNumber?: number;
  prefix: '+' | '-' | ' ';
  side?: ReviewComment['side'];
  text: string;
};

const matchesReviewPatchLine = (
  row: ReviewPatchRow,
  lineNumber: number,
  side: ReviewComment['side'],
) =>
  row.side
    ? row.side === side &&
      (side === 'additions'
        ? row.additionLineNumber === lineNumber
        : row.deletionLineNumber === lineNumber)
    : side === 'additions'
      ? row.additionLineNumber === lineNumber
      : row.deletionLineNumber === lineNumber;

function updateStickyHeaderState(viewer: CodeViewInstance) {
  for (const item of viewer.getRenderedItems()) {
    const header = item.element.querySelector<HTMLElement>('.codiff-file-header');
    if (!header) {
      continue;
    }

    const headerTop = header.getBoundingClientRect().top;
    const itemTop = item.element.getBoundingClientRect().top;
    header.classList.toggle('stuck', headerTop > itemTop + 0.5);
  }
}

type DiffSearchMatch = {
  filePath: string;
  itemId: string;
  lineNumber?: number;
  side?: 'additions' | 'deletions';
};

type DiffSearchResult = {
  file: ChangedFile;
  matchCount: number;
  matches: ReadonlyArray<DiffSearchMatch>;
};

type DiffLineCount = {
  additions: number;
  countable: boolean;
  deletions: number;
};

type ReviewComment = {
  author?: PullRequestExistingReviewComment['author'];
  body: string;
  codexReply?: {
    body?: string;
    error?: string;
    status: 'error' | 'loading' | 'ready';
  };
  filePath: string;
  githubSubmit?: {
    error?: string;
    status: 'error' | 'submitting';
  };
  id: string;
  isReadOnly?: boolean;
  lineNumber: number;
  sectionId: string;
  side: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
  submittedAt?: string;
  url?: string;
};

type SidebarMode = 'tree' | 'walkthrough' | 'history';

type PullRequestSource = Extract<ReviewSource, { type: 'pull-request' }>;

type WalkthroughNote = {
  action: Walkthrough['groups'][number]['files'][number]['action'];
  context: string;
  groupReason: string;
  groupTitle: string;
  impact: Walkthrough['groups'][number]['files'][number]['impact'];
  order: number;
  reason: string;
};

type SourceSession = {
  collapsed: Set<string>;
  reviewComments: ReadonlyArray<ReviewComment>;
  selectedPath: string | null;
  viewed: Record<string, string>;
  walkthrough: Walkthrough | null;
  walkthroughError: string | null;
};

type RepositoryLoadError = {
  kind: 'generic' | 'not-a-repository';
  message: string;
};

const emptyWalkthroughNotes = new Map<string, WalkthroughNote>();

const HISTORY_PAGE_SIZE = 30;

const defaultLaunchOptions: CodiffLaunchOptions = {
  repositoryPathProvided: false,
  walkthrough: false,
};

const defaultTerminalHelperStatus: TerminalHelperStatus = {
  command: 'codiff',
  installed: false,
  path: '',
};

registerCustomTheme('Licht', async () => lichtTheme as never);
registerCustomTheme('Dunkel', async () => dunkelTheme as never);

const statusLabel: Record<GitFileStatus, string> = {
  added: 'Added',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  untracked: 'Untracked',
};

const sectionLabel: Record<DiffSection['kind'], string> = {
  commit: 'Commit',
  'pull-request': 'PR',
  staged: 'Staged',
  unstaged: 'Unstaged',
};

const getSourceKey = (source: ReviewSource) =>
  source.type === 'commit'
    ? `commit:${source.ref}`
    : source.type === 'pull-request'
      ? `pull-request:${source.owner ?? ''}/${source.repo ?? ''}#${source.number ?? source.url}`
      : 'working-tree';

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const getRepositoryLoadError = (error: unknown): RepositoryLoadError => {
  const message = getErrorMessage(error);
  return /not a git repository/i.test(message)
    ? {
        kind: 'not-a-repository',
        message:
          'Codiff was opened outside a Git repository. Run `codiff` from inside a repo, or choose File → Open Folder… to open one.',
      }
    : {
        kind: 'generic',
        message,
      };
};

const getShortRef = (ref: string) => ref.slice(0, 7);

const getSourceLabel = (source: ReviewSource) =>
  source.type === 'commit'
    ? getShortRef(source.ref)
    : source.type === 'pull-request'
      ? source.number
        ? `PR #${source.number}`
        : 'Pull request'
      : 'Uncommitted';

const renderInlineMarkdown = (text: string): ReactNode => {
  const nodes: Array<ReactNode> = [];
  const pattern = /`([^`\n]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const renderText = (value: string, keyPrefix: string): Array<ReactNode> => {
    const textNodes: Array<ReactNode> = [];
    const boldPattern = /\*\*([^*\n]+)\*\*/g;
    let textLastIndex = 0;
    let boldMatch: RegExpExecArray | null;

    while ((boldMatch = boldPattern.exec(value))) {
      if (boldMatch.index > textLastIndex) {
        textNodes.push(value.slice(textLastIndex, boldMatch.index));
      }

      textNodes.push(<strong key={`${keyPrefix}:bold:${boldMatch.index}`}>{boldMatch[1]}</strong>);
      textLastIndex = boldPattern.lastIndex;
    }

    if (textLastIndex < value.length) {
      textNodes.push(value.slice(textLastIndex));
    }

    return textNodes.length > 0 ? textNodes : [value];
  };

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(...renderText(text.slice(lastIndex, match.index), `${lastIndex}`));
    }

    nodes.push(
      <code className="walkthrough-inline-code" key={`${match.index}:${match[1]}`}>
        {match[1]}
      </code>,
    );
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(...renderText(text.slice(lastIndex), `${lastIndex}`));
  }

  return nodes.length > 0 ? nodes : text;
};

const renderMarkdown = (text: string): ReactNode => {
  const blocks: Array<ReactNode> = [];
  const renderTextBlocks = (value: string, keyPrefix: string) => {
    for (const [index, block] of value
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .entries()) {
      const lines = block.split('\n');
      const listItems = lines
        .map((line) => line.trim().match(/^[-*]\s+(.+)$/)?.[1])
        .filter((line): line is string => line != null);

      if (listItems.length === lines.length) {
        blocks.push(
          <ul key={`${keyPrefix}:list:${index}`}>
            {listItems.map((line, lineIndex) => (
              <li key={`${keyPrefix}:list:${index}:${lineIndex}`}>{renderInlineMarkdown(line)}</li>
            ))}
          </ul>,
        );
      } else {
        blocks.push(
          <p key={`${keyPrefix}:p:${index}`}>
            {lines.map((line, lineIndex) => (
              <span key={`${keyPrefix}:p:${index}:${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {renderInlineMarkdown(line)}
              </span>
            ))}
          </p>,
        );
      }
    }
  };

  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(text))) {
    if (match.index > lastIndex) {
      renderTextBlocks(text.slice(lastIndex, match.index), `${lastIndex}`);
    }

    blocks.push(
      <pre key={`code:${match.index}`}>
        <code>{match[2]}</code>
      </pre>,
    );
    lastIndex = fencePattern.lastIndex;
  }

  if (lastIndex < text.length) {
    renderTextBlocks(text.slice(lastIndex), `${lastIndex}`);
  }

  return blocks.length > 0 ? blocks : renderInlineMarkdown(text);
};

const walkthroughActionLabel: Record<WalkthroughNote['action'], string> = {
  review: 'Review',
  scan: 'Scan',
  skim: 'Skim',
};

const walkthroughImpactLabel: Record<WalkthroughNote['impact'], string> = {
  contained: 'Contained',
  mechanical: 'Mechanical',
  wide: 'Wide impact',
};

const statusForTree: Record<
  GitFileStatus,
  'added' | 'deleted' | 'modified' | 'renamed' | 'untracked'
> = {
  added: 'added',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  untracked: 'untracked',
};

// 11px needed to account for the box shadow around individual diffs
const DEFAULT_PADDING = 11;

const codeViewLayout = {
  // 2px is used to account for a 10px gap with the 1px box shadows
  gap: 12,
  paddingBottom: DEFAULT_PADDING,
  paddingTop: DEFAULT_PADDING,
};

const codeViewItemMetrics = {
  diffHeaderHeight: 54,
};

const codeViewItemMetricsWithWalkthrough = {
  diffHeaderHeight: 78,
};

const diffContextExpansionLineCount = 100;
const diffCollapsedContextThreshold = 12;

const workerHighlighterOptions = {
  lineDiffType: 'char' as const,
  maxLineDiffLength: 2000,
  theme: {
    dark: 'Dunkel',
    light: 'Licht',
  },
  tokenizeMaxLineLength: 20_000,
  useTokenTransformer: false,
};

const maxWorkerThreads = 3;

const fileTreeSort = (
  left: { isDirectory: boolean; path: string; segments?: ReadonlyArray<string> },
  right: { isDirectory: boolean; path: string; segments?: ReadonlyArray<string> },
) => compareTreePaths(left.path, right.path);

const defaultPreferences: CodiffPreferences = {
  copyCommentsOnClose: false,
  openAIModel: 'gpt-5.3-codex-spark',
  showWhitespace: false,
  theme: 'system',
};

const codeViewUnsafeCSS = `
  :host {
    --diffs-font-family: var(--font-mono);
    --diffs-header-font-family: var(--font-sans);
    --diffs-font-size: 13px;
    --diffs-line-height: 20px;
    --diffs-light-bg: #ffffff;
    --diffs-dark-bg: #1c1c1c;
    --diffs-bg-selection-override: rgb(61 135 245 / 0.34);
    --diffs-bg-selection-number-override: rgb(61 135 245 / 0.46);
  }

  [data-diff-type="split"][data-overflow="scroll"] {
    grid-template-columns: minmax(0, 42fr) minmax(0, 58fr);
  }

  [data-diffs-header="custom"][data-sticky] {
    background-color: transparent;
    border-radius: 28px 28px 0 0;
  }

  /* Align scrollbar with number column */
  [data-code]::-webkit-scrollbar-track {
    margin-left: var(--diffs-column-number-width);
  }

  /* Ensure right edge of scrollbar never gets cropped by rounded corners */
  [data-file] [data-code]::-webkit-scrollbar-track,
  [data-diff-type="single"] [data-code]::-webkit-scrollbar-track,
  [data-diff-type="split"] [data-code][data-additions]::-webkit-scrollbar-track {
    margin-right: 14px;
  }

  .codiff-search-mark {
    background: var(--diffs-find-highlight-bg, rgb(255 216 92 / 0.65));
    border-radius: 3px;
    color: inherit;
    padding: 0 1px;
  }

  .codiff-search-mark.active {
    background: var(--diffs-find-active-bg, rgb(255 176 46 / 0.96));
    box-shadow: 0 0 0 1px rgb(255 142 36 / 0.4);
  }

  [data-utility-button] {
    background: color-mix(in srgb, var(--diffs-bg) 88%, var(--diffs-modified-base));
    border: 1px solid color-mix(in srgb, var(--diffs-modified-base) 34%, transparent);
    border-radius: 3px;
    box-shadow: 0 7px 18px -14px rgb(0 0 0 / 0.72);
    color: var(--diffs-modified-base);
    height: calc(1lh - 4px);
    transform: translate(-4px, 2px);
    width: calc(1lh - 4px);
  }

  [data-selected-line] [data-gutter-utility-slot] {
    display: none;
  }
`;

const compactPath = (path: string) => {
  const homePath = path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~');
  const parts = homePath.split('/').filter(Boolean);

  if (parts.length <= 2) {
    return homePath;
  }

  const prefix = homePath.startsWith('/') ? '/' : '';
  const [first, ...rest] = parts;
  const last = rest.pop();
  const middle = rest.map((part) => part[0]).join('/');

  return `${prefix}${first}/${middle ? `${middle}/` : ''}${last}`;
};

function compareTreePaths(leftPath: string, rightPath: string) {
  const leftParts = leftPath.split('/');
  const rightParts = rightPath.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = leftParts[index];
    const right = rightParts[index];
    if (left === right) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return left.localeCompare(right);
  }

  return leftParts.length - rightParts.length;
}

const sortFiles = (files: ReadonlyArray<ChangedFile>) =>
  [...files].sort((left, right) => compareTreePaths(left.path, right.path));

const getWalkthroughNotes = (walkthrough: Walkthrough | null) => {
  const notes = new Map<string, WalkthroughNote>();
  if (!walkthrough) {
    return notes;
  }

  let order = 0;
  for (const group of walkthrough.groups) {
    for (const file of group.files) {
      if (!notes.has(file.path)) {
        notes.set(file.path, {
          action: file.action,
          context: file.context,
          groupReason: group.reason,
          groupTitle: group.title,
          impact: file.impact,
          order,
          reason: file.reason,
        });
        order += 1;
      }
    }
  }

  return notes;
};

const orderFilesByWalkthrough = (
  files: ReadonlyArray<ChangedFile>,
  walkthrough: Walkthrough | null,
) => {
  if (!walkthrough) {
    return files;
  }

  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const orderedFiles: Array<ChangedFile> = [];
  const seen = new Set<string>();

  for (const group of walkthrough.groups) {
    for (const item of group.files) {
      const file = filesByPath.get(item.path);
      if (file && !seen.has(file.path)) {
        orderedFiles.push(file);
        seen.add(file.path);
      }
    }
  }

  for (const file of files) {
    if (!seen.has(file.path)) {
      orderedFiles.push(file);
    }
  }

  return orderedFiles;
};

const fuzzyMatches = (path: string, query: string) => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const normalizedPath = path.toLowerCase();
  let pathIndex = 0;
  for (const character of normalizedQuery) {
    pathIndex = normalizedPath.indexOf(character, pathIndex);
    if (pathIndex === -1) {
      return false;
    }
    pathIndex += 1;
  }
  return true;
};

type NativeInputEventTarget = EventTarget & {
  closest?: (selector: string) => Element | null;
  isContentEditable?: boolean;
};

export const isNativeInputTarget = (target: EventTarget | null) => {
  const candidate = target as NativeInputEventTarget | null;
  return (
    candidate?.closest?.('input, select, textarea') != null || candidate?.isContentEditable === true
  );
};

const isMacPlatform = (platform = navigator.platform) => platform.toLowerCase().includes('mac');

export const isDiffSearchShortcut = (
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  platform = navigator.platform,
) => {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') {
    return false;
  }

  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
};

const getViewedKey = (root: string) => `codiff:viewed:${root}`;

const getReloadShortcutLabel = () => {
  return isMacPlatform() ? '⌘R' : 'Ctrl+R';
};

const readViewed = (root: string): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(getViewedKey(root)) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

const writeViewed = (root: string, viewed: Record<string, string>) => {
  localStorage.setItem(getViewedKey(root), JSON.stringify(viewed));
};

const getItemId = (section: DiffSection) => `diff:${section.id}`;

const emptyDiffLineCount: DiffLineCount = {
  additions: 0,
  countable: false,
  deletions: 0,
};

const getDiffLineCountFromVisibleSections = (
  sections: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    section: DiffSection;
  }>,
): DiffLineCount => {
  let additions = 0;
  let countable = false;
  let deletions = 0;

  for (const { fileDiff, section } of sections) {
    if (section.binary || (section.loadState != null && section.loadState !== 'ready')) {
      continue;
    }

    countable = true;
    for (const hunk of fileDiff.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
  }

  return countable
    ? {
        additions,
        countable,
        deletions,
      }
    : emptyDiffLineCount;
};

export const getDiffLineCount = (file: ChangedFile, showWhitespace: boolean): DiffLineCount =>
  getDiffLineCountFromVisibleSections(getVisibleDiffSections(file, showWhitespace));

const formatLineCountNumber = (value: number) => value.toLocaleString('en-US');

const formatCompactLineCountNumber = (value: number) => {
  if (value < 1000) {
    return String(value);
  }

  if (value < 10_000) {
    return `${Number((value / 1000).toFixed(1))}k`;
  }

  if (value < 1_000_000) {
    return `${Math.round(value / 1000)}k`;
  }

  return `${Number((value / 1_000_000).toFixed(1))}m`;
};

const formatTreeLineCount = ({ additions, deletions }: DiffLineCount) =>
  `+${formatCompactLineCountNumber(additions)} -${formatCompactLineCountNumber(deletions)}`;

const pluralizeLine = (count: number) => (count === 1 ? 'line' : 'lines');

const getDiffLineCountTitle = ({ additions, deletions }: DiffLineCount) =>
  `${formatLineCountNumber(additions)} added ${pluralizeLine(
    additions,
  )}, ${formatLineCountNumber(deletions)} removed ${pluralizeLine(deletions)}`;

const countOccurrences = (text: string, normalizedQuery: string) => {
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  let count = 0;
  let index = normalizedText.indexOf(normalizedQuery);
  while (index !== -1) {
    count += 1;
    index = normalizedText.indexOf(normalizedQuery, index + normalizedQuery.length);
  }

  return count;
};

const lineContainsQuery = (text: string | undefined, normalizedQuery: string) =>
  text != null && text.toLowerCase().includes(normalizedQuery);

export const getDiffSearchResult = (
  file: ChangedFile,
  showWhitespace: boolean,
  query: string,
): DiffSearchResult | null => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return null;
  }

  const matches: Array<DiffSearchMatch> = [];
  let matchCount = 0;
  const seenLineMatches = new Set<string>();

  const pushMatch = (match: DiffSearchMatch, occurrences: number) => {
    matchCount += occurrences;
    const key = `${match.itemId}:${match.side ?? 'header'}:${match.lineNumber ?? 'header'}`;
    if (!seenLineMatches.has(key)) {
      seenLineMatches.add(key);
      matches.push(match);
    }
  };

  const headerOccurrences =
    countOccurrences(file.path, normalizedQuery) +
    (file.oldPath ? countOccurrences(file.oldPath, normalizedQuery) : 0);

  if (headerOccurrences > 0) {
    const section = getFirstVisibleSection(file, showWhitespace);
    if (section) {
      pushMatch(
        {
          filePath: file.path,
          itemId: getItemId(section),
        },
        headerOccurrences,
      );
    }
  }

  for (const { fileDiff, section } of getVisibleDiffSections(file, showWhitespace)) {
    const itemId = getItemId(section);

    for (const hunk of fileDiff.hunks) {
      let deletionLineNumber = hunk.deletionStart;
      let additionLineNumber = hunk.additionStart;

      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          for (let index = 0; index < content.lines; index += 1) {
            const line = fileDiff.additionLines[content.additionLineIndex + index];
            const occurrences = countOccurrences(line ?? '', normalizedQuery);
            if (occurrences > 0) {
              pushMatch(
                {
                  filePath: file.path,
                  itemId,
                  lineNumber: additionLineNumber + index,
                  side: 'additions',
                },
                occurrences,
              );
            }
          }

          deletionLineNumber += content.lines;
          additionLineNumber += content.lines;
          continue;
        }

        for (let index = 0; index < content.deletions; index += 1) {
          const line = fileDiff.deletionLines[content.deletionLineIndex + index];
          const occurrences = countOccurrences(line ?? '', normalizedQuery);
          if (occurrences > 0) {
            pushMatch(
              {
                filePath: file.path,
                itemId,
                lineNumber: deletionLineNumber + index,
                side: 'deletions',
              },
              occurrences,
            );
          }
        }

        for (let index = 0; index < content.additions; index += 1) {
          const line = fileDiff.additionLines[content.additionLineIndex + index];
          const occurrences = countOccurrences(line ?? '', normalizedQuery);
          if (occurrences > 0) {
            pushMatch(
              {
                filePath: file.path,
                itemId,
                lineNumber: additionLineNumber + index,
                side: 'additions',
              },
              occurrences,
            );
          }
        }

        deletionLineNumber += content.deletions;
        additionLineNumber += content.additions;
      }
    }

    if (section.summary?.reason && lineContainsQuery(section.summary.reason, normalizedQuery)) {
      pushMatch(
        {
          filePath: file.path,
          itemId,
          lineNumber: 1,
          side: 'additions',
        },
        countOccurrences(section.summary.reason, normalizedQuery),
      );
    }
  }

  return matches.length > 0
    ? {
        file,
        matchCount,
        matches,
      }
    : null;
};

const searchMarkSelector = 'mark.codiff-search-mark';

const clearSearchHighlights = (root: ParentNode) => {
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>(searchMarkSelector))) {
    const parent = mark.parentElement;
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
    parent?.normalize();
  }
};

const getSearchableRoots = (element: HTMLElement): Array<ParentNode> => {
  const roots: Array<ParentNode> = [element];
  if (element.shadowRoot) {
    roots.push(element.shadowRoot);
  }
  return roots;
};

const isNodeInsideSearchMark = (node: Node) =>
  node.parentElement?.closest(searchMarkSelector) != null;

const highlightTextContainer = (
  container: HTMLElement,
  normalizedQuery: string,
  activeMatch: DiffSearchMatch | null,
) => {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent && node.textContent.toLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const textNodes: Array<Text> = [];
  let node = walker.nextNode();
  while (node) {
    if (!isNodeInsideSearchMark(node)) {
      textNodes.push(node as Text);
    }
    node = walker.nextNode();
  }

  const row = container.closest<HTMLElement>('[data-line]');
  const codeColumn = container.closest<HTMLElement>('[data-code]');
  const side = codeColumn?.hasAttribute('data-deletions') ? 'deletions' : 'additions';
  const isActiveLine =
    activeMatch?.lineNumber != null &&
    Number(row?.dataset.line) === activeMatch.lineNumber &&
    activeMatch.side === side;

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? '';
    const fragment = document.createDocumentFragment();
    let offset = 0;
    let matchIndex = text.toLowerCase().indexOf(normalizedQuery);

    while (matchIndex !== -1) {
      if (matchIndex > offset) {
        fragment.append(document.createTextNode(text.slice(offset, matchIndex)));
      }

      const mark = document.createElement('mark');
      mark.className = `codiff-search-mark${isActiveLine ? ' active' : ''}`;
      mark.textContent = text.slice(matchIndex, matchIndex + normalizedQuery.length);
      fragment.append(mark);
      offset = matchIndex + normalizedQuery.length;
      matchIndex = text.toLowerCase().indexOf(normalizedQuery, offset);
    }

    if (offset < text.length) {
      fragment.append(document.createTextNode(text.slice(offset)));
    }

    textNode.replaceWith(fragment);
  }
};

const applySearchHighlights = (
  renderedItems: ReadonlyArray<{ element: HTMLElement; id: string }>,
  query: string,
  activeMatch: DiffSearchMatch | null,
) => {
  const normalizedQuery = query.trim().toLowerCase();

  for (const { element, id } of renderedItems) {
    for (const root of getSearchableRoots(element)) {
      clearSearchHighlights(root);

      if (!normalizedQuery) {
        continue;
      }

      const matchForItem = activeMatch && activeMatch.itemId === id ? activeMatch : null;

      for (const container of Array.from(
        root.querySelectorAll<HTMLElement>('[data-code] [data-column-content]'),
      )) {
        highlightTextContainer(container, normalizedQuery, matchForItem);
      }
    }
  }
};

const getItemVersion = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash >>> 0;
};

type CodeViewItemMetadata = {
  file: ChangedFile;
  isCollapsed: boolean;
  isSelected: boolean;
  isViewed: boolean;
  lineCount: DiffLineCount;
  section: DiffSection;
  sectionCount: number;
  walkthroughNote?: WalkthroughNote;
};

const createBinaryFileDiff = (file: ChangedFile, section: DiffSection): FileDiffMetadata => ({
  additionLines: [`${section.summary?.reason ?? 'Binary file changed.'}\n`],
  cacheKey: `summary:${file.fingerprint}:${section.id}:${section.loadState ?? 'binary'}:${
    section.summary?.reason ?? ''
  }`,
  deletionLines: [],
  hunks: [
    {
      additionCount: 1,
      additionLineIndex: 0,
      additionLines: 1,
      additionStart: 1,
      collapsedBefore: 0,
      deletionCount: 0,
      deletionLineIndex: 0,
      deletionLines: 0,
      deletionStart: 0,
      hunkContent: [
        {
          additionLineIndex: 0,
          additions: 1,
          deletionLineIndex: 0,
          deletions: 0,
          type: 'change',
        },
      ],
      hunkSpecs: '@@ -0,0 +1 @@\n',
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
      splitLineCount: 1,
      splitLineStart: 0,
      unifiedLineCount: 1,
      unifiedLineStart: 0,
    },
  ],
  isPartial: true,
  name: file.path,
  prevName: file.oldPath,
  splitLineCount: 1,
  type: file.status === 'deleted' ? 'deleted' : file.status === 'added' ? 'new' : 'change',
  unifiedLineCount: 1,
});

const createEmptyFileDiff = (file: ChangedFile, section: DiffSection): FileDiffMetadata => ({
  additionLines: section.newFile?.contents.split('\n') ?? [],
  cacheKey: `empty:${file.fingerprint}:${section.id}`,
  deletionLines: section.oldFile?.contents.split('\n') ?? [],
  hunks: [],
  isPartial: false,
  name: section.newFile?.name ?? file.path,
  prevName: section.oldFile?.name ?? file.oldPath,
  splitLineCount: 0,
  type: file.status === 'deleted' ? 'deleted' : file.status === 'added' ? 'new' : 'change',
  unifiedLineCount: 0,
});

const parsedDiffCache = new Map<string, FileDiffMetadata>();

const getSectionCacheIdentity = (section: DiffSection) =>
  [
    section.loadState ?? 'ready',
    section.summary?.reason ?? '',
    section.oldFile?.cacheKey ?? '',
    section.newFile?.cacheKey ?? '',
    section.patch.length,
  ].join(':');

const parseSectionDiffWithOptions = (
  file: ChangedFile,
  section: DiffSection,
  showWhitespace: boolean,
): FileDiffMetadata => {
  const cacheKey = `${file.fingerprint}:${section.id}:${getSectionCacheIdentity(section)}:${
    showWhitespace ? 'ws' : 'ignore-ws'
  }`;
  const cached = parsedDiffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let fileDiff: FileDiffMetadata;
  if (section.binary || (section.loadState != null && section.loadState !== 'ready')) {
    fileDiff = createBinaryFileDiff(file, section);
  } else if (section.oldFile && section.newFile) {
    try {
      fileDiff = {
        ...parseDiffFromFile(section.oldFile, section.newFile, {
          ignoreWhitespace: !showWhitespace,
        }),
        cacheKey,
      };
    } catch {
      fileDiff = createEmptyFileDiff(file, section);
    }
  } else {
    const parsedFileDiff = parsePatchFiles(section.patch)[0]?.files[0];
    fileDiff = parsedFileDiff
      ? {
          ...parsedFileDiff,
          cacheKey,
        }
      : createBinaryFileDiff(file, section);
  }

  parsedDiffCache.set(cacheKey, fileDiff);
  return fileDiff;
};

const fileHasMetadataDiff = (file: ChangedFile) =>
  file.status === 'renamed' && file.oldPath != null && file.oldPath !== file.path;

const sectionHasVisibleDiff = (
  file: ChangedFile,
  section: DiffSection,
  fileDiff: FileDiffMetadata,
) =>
  section.binary ||
  (section.loadState != null && section.loadState !== 'ready') ||
  fileHasMetadataDiff(file) ||
  fileDiff.hunks.length > 0;

export const getVisibleDiffSections = (file: ChangedFile, showWhitespace: boolean) =>
  file.sections
    .map((section) => ({
      fileDiff: parseSectionDiffWithOptions(file, section, showWhitespace),
      section,
    }))
    .filter(({ fileDiff, section }) => sectionHasVisibleDiff(file, section, fileDiff));

export const fileHasVisibleDiff = (file: ChangedFile, showWhitespace: boolean) =>
  getVisibleDiffSections(file, showWhitespace).length > 0;

const getFirstVisibleSection = (file: ChangedFile, showWhitespace: boolean) =>
  getVisibleDiffSections(file, showWhitespace)[0]?.section;

const getReviewSideLabel = (side: ReviewComment['side']) => (side === 'additions' ? 'New' : 'Old');

const getReviewCommentStartSide = (comment: Pick<ReviewComment, 'side' | 'startSide'>) =>
  comment.startSide ?? comment.side;

const getReviewCommentLineLabel = (
  comment: Pick<ReviewComment, 'lineNumber' | 'side' | 'startLineNumber' | 'startSide'>,
) => {
  const startLineNumber = comment.startLineNumber;
  const startSide = getReviewCommentStartSide(comment);
  if (
    startLineNumber == null ||
    (startLineNumber === comment.lineNumber && startSide === comment.side)
  ) {
    return `${getReviewSideLabel(comment.side)} line ${comment.lineNumber}`;
  }

  if (startSide === comment.side) {
    return `${getReviewSideLabel(comment.side)} lines ${startLineNumber}-${comment.lineNumber}`;
  }

  return `${getReviewSideLabel(startSide)} line ${startLineNumber} to ${getReviewSideLabel(
    comment.side,
  )} line ${comment.lineNumber}`;
};

const getReviewCommentRangeProps = (
  comment: Pick<ReviewComment, 'lineNumber' | 'side' | 'startLineNumber' | 'startSide'>,
) => {
  const startLineNumber = comment.startLineNumber;
  if (startLineNumber == null) {
    return {};
  }

  const startSide = getReviewCommentStartSide(comment);
  return startLineNumber !== comment.lineNumber || startSide !== comment.side
    ? {
        startLineNumber,
        ...(startSide !== comment.side ? { startSide } : {}),
      }
    : {};
};

const getCommentKey = (
  comment: Pick<
    ReviewComment,
    'lineNumber' | 'sectionId' | 'side' | 'startLineNumber' | 'startSide'
  >,
) =>
  `${comment.sectionId}:${comment.side}:${comment.lineNumber}:${comment.startLineNumber ?? comment.lineNumber}:${
    comment.startSide ?? comment.side
  }`;

const getReviewCommentsDigest = (comments: ReadonlyArray<ReviewComment>) =>
  comments
    .map(
      (comment) =>
        `${comment.id}:${comment.sectionId}:${comment.side}:${comment.lineNumber}:${
          comment.startLineNumber ?? ''
        }:${comment.startSide ?? ''}:${
          comment.githubSubmit?.status ?? ''
        }:${comment.githubSubmit?.error ?? ''}`,
    )
    .join('\0');

const getMarkdownFence = (content: string) => {
  let fence = '```';
  while (content.includes(fence)) {
    fence += '`';
  }
  return fence;
};

const indentMarkdown = (value: string) =>
  value
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');

const formatReviewLineNumber = (lineNumber: number | string) => String(lineNumber).padStart(4);

const getReviewCommentPatchContext = (
  file: ChangedFile,
  section: DiffSection,
  comment: ReviewComment,
  showWhitespace: boolean,
) => {
  const fileDiff = parseSectionDiffWithOptions(file, section, showWhitespace);

  for (const hunk of fileDiff.hunks) {
    const rows: Array<ReviewPatchRow> = [];
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let index = 0; index < content.lines; index += 1) {
          rows.push({
            additionLineNumber: additionLineNumber + index,
            deletionLineNumber: deletionLineNumber + index,
            prefix: ' ',
            text: fileDiff.additionLines[content.additionLineIndex + index] ?? '',
          });
        }
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      for (let index = 0; index < content.deletions; index += 1) {
        rows.push({
          deletionLineNumber: deletionLineNumber + index,
          prefix: '-',
          side: 'deletions',
          text: fileDiff.deletionLines[content.deletionLineIndex + index] ?? '',
        });
      }

      for (let index = 0; index < content.additions; index += 1) {
        rows.push({
          additionLineNumber: additionLineNumber + index,
          prefix: '+',
          side: 'additions',
          text: fileDiff.additionLines[content.additionLineIndex + index] ?? '',
        });
      }

      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }

    const startLine = comment.startLineNumber ?? comment.lineNumber;
    const startSide = getReviewCommentStartSide(comment);
    const endLine = comment.lineNumber;
    const targetIndex = rows.findIndex((row) => matchesReviewPatchLine(row, endLine, comment.side));
    const rangeStartIndex = rows.findIndex((row) =>
      matchesReviewPatchLine(row, startLine, startSide),
    );

    if (targetIndex === -1) {
      continue;
    }

    const anchorStart = rangeStartIndex === -1 ? targetIndex : rangeStartIndex;
    const start = Math.max(0, Math.min(anchorStart, targetIndex) - 3);
    const end = Math.min(rows.length, Math.max(anchorStart, targetIndex) + 4);
    const context = rows.slice(start, end).map((row) => {
      const lineNumber =
        row.prefix === '+'
          ? row.additionLineNumber
          : row.prefix === '-'
            ? row.deletionLineNumber
            : `${row.deletionLineNumber ?? ''}/${row.additionLineNumber ?? ''}`;
      return `${row.prefix}${formatReviewLineNumber(lineNumber ?? '')} | ${row.text}`;
    });

    return [hunk.hunkSpecs?.trim(), ...context].filter(Boolean).join('\n');
  }

  return section.summary?.reason || section.patch.trim() || 'No patch context available.';
};

export const buildReviewCommentsMarkdown = (
  files: ReadonlyArray<ChangedFile>,
  comments: ReadonlyArray<ReviewComment>,
  showWhitespace: boolean,
) => {
  const pendingComments = comments.filter((comment) => !comment.isReadOnly && comment.body.trim());
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const orderedComments = pendingComments.sort((left, right) => {
    const leftFileIndex = files.findIndex((file) => file.path === left.filePath);
    const rightFileIndex = files.findIndex((file) => file.path === right.filePath);
    return (
      leftFileIndex - rightFileIndex ||
      left.lineNumber - right.lineNumber ||
      left.id.localeCompare(right.id)
    );
  });

  const markdown = orderedComments
    .map((comment, index) => {
      const file = filesByPath.get(comment.filePath);
      const section = file?.sections.find((candidate) => candidate.id === comment.sectionId);
      const context =
        file && section
          ? getReviewCommentPatchContext(file, section, comment, showWhitespace)
          : 'No patch context available.';
      const fence = getMarkdownFence(context);

      return [
        `${index + 1}. **${comment.filePath}** (${getReviewCommentLineLabel(comment)})`,
        '',
        indentMarkdown(`${fence}diff\n${context}\n${fence}`),
        '',
        indentMarkdown(comment.body.trim()),
      ].join('\n');
    })
    .join('\n\n');

  return markdown ? `# Address these Review Comments\n\n${markdown}` : '';
};

const getReviewCommentsFromState = (state: RepositoryState): ReadonlyArray<ReviewComment> =>
  state.source.type === 'pull-request'
    ? (state.reviewComments ?? []).flatMap((comment) => {
        const file = state.files.find((candidate) => candidate.path === comment.filePath);
        const section = file?.sections[0];
        return section
          ? [
              {
                author: comment.author,
                body: comment.body,
                filePath: comment.filePath,
                id: comment.id,
                isReadOnly: true,
                lineNumber: comment.lineNumber,
                sectionId: section.id,
                side: comment.side,
                ...getReviewCommentRangeProps(comment),
                submittedAt: comment.submittedAt,
                url: comment.url,
              },
            ]
          : [];
      })
    : [];

export const shouldDiscardReviewCommentOnEscape = (
  body: string,
  confirmDiscard: (message: string) => boolean = window.confirm,
) => body.trim().length === 0 || confirmDiscard('Discard this review comment?');

function Sidebar({
  currentSource,
  files,
  historyEntries,
  historyHasMore,
  historyLoading,
  mode,
  onActivatePath,
  onLoadMoreHistory,
  onModeChange,
  onSearchQueryChange,
  onSelectPath,
  onSelectSource,
  pullRequestSource,
  searchQuery,
  selectedPath,
  showWhitespace,
  walkthroughAvailable,
  walkthroughError,
  walkthroughLoading,
  walkthroughNotes,
  walkthroughSummary,
  walkthroughUnread,
}: {
  currentSource: ReviewSource;
  files: ReadonlyArray<ChangedFile>;
  historyEntries: ReadonlyArray<HistoryEntry>;
  historyHasMore: boolean;
  historyLoading: boolean;
  mode: SidebarMode;
  onActivatePath: (path: string) => void;
  onLoadMoreHistory: () => void;
  onModeChange: (mode: SidebarMode) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectPath: (path: string) => void;
  onSelectSource: (source: ReviewSource) => void;
  pullRequestSource: PullRequestSource | null;
  searchQuery: string;
  selectedPath: string | null;
  showWhitespace: boolean;
  walkthroughAvailable: boolean;
  walkthroughError: string | null;
  walkthroughLoading: boolean;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
  walkthroughSummary: Walkthrough['summary'] | null;
  walkthroughUnread: boolean;
}) {
  const allowSelectionScroll = useRef(false);
  const allowSelectionScrollTimer = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const treeHostRef = useRef<HTMLDivElement>(null);
  const suppressSelectionChange = useRef(false);
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const lineCountsByPath = useMemo(
    () => new Map(files.map((file) => [file.path, getDiffLineCount(file, showWhitespace)])),
    [files, showWhitespace],
  );
  const lineCountsByPathRef = useRef(lineCountsByPath);
  const renderTreeRowDecoration = useCallback<FileTreeRowDecorationRenderer>(({ item }) => {
    const lineCount = lineCountsByPathRef.current.get(item.path);
    return lineCount?.countable
      ? {
          text: formatTreeLineCount(lineCount),
          title: getDiffLineCountTitle(lineCount),
        }
      : null;
  }, []);
  const status = useMemo(
    () =>
      files.map((file) => ({
        path: file.path,
        status: statusForTree[file.status],
      })),
    [files],
  );
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: status,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 30,
    onSelectionChange: (paths) => {
      if (suppressSelectionChange.current) {
        return;
      }

      if (!allowSelectionScroll.current) {
        return;
      }
      allowSelectionScroll.current = false;
      if (allowSelectionScrollTimer.current != null) {
        window.clearTimeout(allowSelectionScrollTimer.current);
        allowSelectionScrollTimer.current = null;
      }

      const path = paths.at(-1);
      if (path) {
        onSelectPath(path);
      }
    },
    paths,
    renderRowDecoration: renderTreeRowDecoration,
    sort: fileTreeSort,
    unsafeCSS: `
      :host {
        --trees-padding-inline-override: 4px;
        color: var(--sidebar-text);
        font: 13px/1.35 var(--font-sans);
      }

      button[data-type='item'] {
        border-radius: 14px;
        corner-shape: squircle;
      }

      [data-item-section='decoration'] {
        color: var(--muted);
        font: 600 10px/1 var(--font-mono);
        letter-spacing: 0;
      }
    `,
  });

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    lineCountsByPathRef.current = lineCountsByPath;
  }, [lineCountsByPath]);

  useEffect(() => {
    model.setGitStatus(status);
  }, [lineCountsByPath, model, status]);

  const scrollPathIntoView = useCallback(
    (path: string) => {
      model.focusPath(path);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const host = treeHostRef.current?.querySelector('file-tree-container');
          const row = Array.from(
            host?.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-path]') ?? [],
          ).find((element) => element.getAttribute('data-item-path') === path);
          row?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        });
      });
    },
    [model],
  );

  const handleTreeClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      for (const target of event.nativeEvent.composedPath()) {
        if (!('getAttribute' in target) || typeof target.getAttribute !== 'function') {
          continue;
        }

        const path = target.getAttribute('data-item-path');
        if (path && filePathSet.has(path)) {
          onActivatePath(path);
          return;
        }
      }
    },
    [filePathSet, onActivatePath],
  );

  useEffect(
    () => () => {
      if (allowSelectionScrollTimer.current != null) {
        window.clearTimeout(allowSelectionScrollTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !isNativeInputTarget(event.target) &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'p'
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    const selectedPaths = model.getSelectedPaths();
    if (selectedPaths.length === 1 && selectedPaths[0] === selectedPath) {
      return;
    }

    suppressSelectionChange.current = true;
    for (const path of selectedPaths) {
      model.getItem(path)?.deselect();
    }
    model.getItem(selectedPath)?.select();
    requestAnimationFrame(() => scrollPathIntoView(selectedPath));
    window.setTimeout(() => {
      suppressSelectionChange.current = false;
    }, 0);
  }, [model, scrollPathIntoView, selectedPath]);

  return (
    <>
      <div className="sidebar-search-row">
        <input
          aria-label="Filter changed files"
          className="sidebar-search"
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          placeholder={mode === 'history' ? 'Filter history' : 'Filter files'}
          ref={searchInputRef}
          spellCheck={false}
          type="search"
          value={searchQuery}
        />
      </div>
      <div aria-label="Review order" className="sidebar-mode-toggle" role="tablist">
        <button
          aria-selected={mode === 'tree'}
          onClick={() => onModeChange('tree')}
          role="tab"
          type="button"
        >
          Tree
        </button>
        <button
          aria-selected={mode === 'walkthrough'}
          onClick={() => onModeChange('walkthrough')}
          role="tab"
          type="button"
        >
          <span>Walkthrough</span>
          {walkthroughUnread ? <span aria-hidden className="sidebar-tab-dot" /> : null}
        </button>
        <button
          aria-selected={mode === 'history'}
          onClick={() => onModeChange('history')}
          role="tab"
          type="button"
        >
          History
        </button>
      </div>
      {mode === 'history' ? (
        <HistorySidebar
          currentSource={currentSource}
          entries={historyEntries}
          hasMore={historyHasMore}
          loading={historyLoading}
          onLoadMore={onLoadMoreHistory}
          onSelectSource={onSelectSource}
          pullRequestSource={pullRequestSource}
          searchQuery={searchQuery}
        />
      ) : mode === 'walkthrough' && walkthroughAvailable ? (
        <WalkthroughSidebar
          files={files}
          onActivatePath={onActivatePath}
          selectedPath={selectedPath}
          showWhitespace={showWhitespace}
          walkthroughNotes={walkthroughNotes}
          walkthroughSummary={walkthroughSummary}
        />
      ) : mode === 'walkthrough' ? (
        <>
          {walkthroughLoading ? (
            <div className="sidebar-walkthrough-status-shell">
              <div className="sidebar-walkthrough-status codex">
                <strong>Waiting on Codex…</strong>
              </div>
            </div>
          ) : walkthroughError ? (
            <div className="sidebar-walkthrough-status" title={walkthroughError}>
              <strong>Walkthrough unavailable</strong>
              <span>{walkthroughError}</span>
            </div>
          ) : null}
          {!walkthroughLoading ? (
            <div className="file-tree-shell" ref={treeHostRef}>
              <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="file-tree-shell" ref={treeHostRef}>
          <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
        </div>
      )}
    </>
  );
}

function HistorySidebar({
  currentSource,
  entries,
  hasMore,
  loading,
  onLoadMore,
  onSelectSource,
  pullRequestSource,
  searchQuery,
}: {
  currentSource: ReviewSource;
  entries: ReadonlyArray<HistoryEntry>;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onSelectSource: (source: ReviewSource) => void;
  pullRequestSource: PullRequestSource | null;
  searchQuery: string;
}) {
  const currentSourceKey = getSourceKey(currentSource);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () =>
      [
        pullRequestSource
          ? {
              committedAt: null,
              key: getSourceKey(pullRequestSource),
              ref: pullRequestSource.number ? `PR #${pullRequestSource.number}` : 'PR',
              source: pullRequestSource satisfies ReviewSource,
              subject: pullRequestSource.title || 'Pull Request',
            }
          : null,
        {
          committedAt: null,
          key: 'working-tree',
          ref: '',
          source: { type: 'working-tree' } satisfies ReviewSource,
          subject: 'Uncommitted',
        },
        ...entries.map((entry) => ({
          committedAt: entry.committedAt,
          key: `commit:${entry.ref}`,
          ref: entry.ref,
          source: { ref: entry.ref, type: 'commit' } satisfies ReviewSource,
          subject: entry.subject,
        })),
      ].filter((row): row is NonNullable<typeof row> => row != null),
    [entries, pullRequestSource],
  );
  const visibleRows = useMemo(
    () =>
      normalizedQuery
        ? rows.filter(
            (row) =>
              row.subject.toLowerCase().includes(normalizedQuery) ||
              row.ref.toLowerCase().includes(normalizedQuery),
          )
        : rows,
    [normalizedQuery, rows],
  );
  const maybeLoadMore = useCallback(() => {
    const element = listRef.current;
    if (!element || loading || !hasMore || normalizedQuery) {
      return;
    }

    if (element.scrollHeight - element.scrollTop - element.clientHeight < 120) {
      onLoadMore();
    }
  }, [hasMore, loading, normalizedQuery, onLoadMore]);

  return (
    <div className="history-list" onScroll={maybeLoadMore} ref={listRef}>
      {visibleRows.map((row) => {
        const selected = row.key === currentSourceKey;
        return (
          <button
            className={`history-entry${selected ? ' selected' : ''}`}
            key={row.key}
            onClick={() => onSelectSource(row.source)}
            title={row.subject}
            type="button"
          >
            <span className="history-entry-ref">
              {row.source.type === 'commit'
                ? getShortRef(row.source.ref)
                : row.source.type === 'pull-request'
                  ? row.ref
                  : 'local'}
            </span>
            <span className="history-entry-subject">{row.subject}</span>
          </button>
        );
      })}
      {loading ? (
        <div className="history-loading">
          <span>Loading history…</span>
        </div>
      ) : null}
    </div>
  );
}

function WalkthroughSidebar({
  files,
  onActivatePath,
  selectedPath,
  showWhitespace,
  walkthroughNotes,
  walkthroughSummary,
}: {
  files: ReadonlyArray<ChangedFile>;
  onActivatePath: (path: string) => void;
  selectedPath: string | null;
  showWhitespace: boolean;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
  walkthroughSummary: Walkthrough['summary'] | null;
}) {
  const groups = useMemo(() => {
    const nextGroups: Array<{
      files: Array<{ file: ChangedFile; note?: WalkthroughNote }>;
      key: string;
      reason: string;
      title: string;
    }> = [];
    const groupsByTitle = new Map<string, (typeof nextGroups)[number]>();

    for (const file of files) {
      const note = walkthroughNotes.get(file.path);
      const title = note?.groupTitle ?? 'Other changed files';
      const reason = note?.groupReason ?? 'Review after the primary walkthrough.';
      const key = `${title}:${reason}`;
      let group = groupsByTitle.get(key);

      if (!group) {
        group = {
          files: [],
          key,
          reason,
          title,
        };
        groupsByTitle.set(key, group);
        nextGroups.push(group);
      }

      group.files.push({ file, note });
    }

    return nextGroups;
  }, [files, walkthroughNotes]);

  return (
    <div className="walkthrough-list">
      {walkthroughSummary ? (
        <div className="walkthrough-summary">
          <strong>Review Focus</strong>
          <span>{renderInlineMarkdown(walkthroughSummary.focus)}</span>
          <span>{renderInlineMarkdown(walkthroughSummary.skim)}</span>
        </div>
      ) : null}
      {groups.map((group) => (
        <section className="walkthrough-group" key={group.key}>
          <div className="walkthrough-group-header" title={`${group.title}. ${group.reason}`}>
            <span>{group.title}</span>
            <small>{renderInlineMarkdown(group.reason)}</small>
          </div>
          {group.files.map(({ file, note }) => {
            const lineCount = getDiffLineCount(file, showWhitespace);
            return (
              <button
                className={`walkthrough-file${selectedPath === file.path ? ' selected' : ''}`}
                key={file.path}
                onClick={() => onActivatePath(file.path)}
                title={note?.reason ?? file.path}
                type="button"
              >
                <span className="walkthrough-file-title">
                  <span className="walkthrough-file-path">{file.path}</span>
                  <DiffLineCountBadge className="walkthrough-line-count" lineCount={lineCount} />
                </span>
                {note ? (
                  <span className="walkthrough-file-meta">
                    {walkthroughImpactLabel[note.impact]} · {walkthroughActionLabel[note.action]}
                  </span>
                ) : null}
                <span className="walkthrough-file-reason">
                  {renderInlineMarkdown(
                    note?.context ?? note?.reason ?? 'Review this changed file.',
                  )}
                </span>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function DiffLineCountBadge({
  className = 'codiff-line-count',
  lineCount,
}: {
  className?: string;
  lineCount: DiffLineCount;
}) {
  if (!lineCount.countable) {
    return null;
  }

  return (
    <span
      aria-label={getDiffLineCountTitle(lineCount)}
      className={className}
      title={getDiffLineCountTitle(lineCount)}
    >
      <span className="codiff-line-count-added">+{formatLineCountNumber(lineCount.additions)}</span>
      <span className="codiff-line-count-deleted">
        -{formatLineCountNumber(lineCount.deletions)}
      </span>
    </span>
  );
}

function CodeViewHeader({
  meta,
  onOpenFile,
  onToggleCollapsed,
  onToggleViewed,
}: {
  meta: CodeViewItemMetadata;
  onOpenFile: (file: ChangedFile) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
}) {
  const {
    file,
    isCollapsed,
    isSelected,
    isViewed,
    lineCount,
    section,
    sectionCount,
    walkthroughNote,
  } = meta;
  const canOpenFile = file.status !== 'deleted';

  return (
    <div
      className={`codiff-file-header${walkthroughNote ? ' with-note' : ''}${
        isCollapsed ? ' collapsed' : ''
      }${isSelected ? ' selected' : ''}${isViewed ? ' viewed' : ''}`}
    >
      <button
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? 'Expand file' : 'Collapse file'}
        className="codiff-header-toggle"
        onClick={() => onToggleCollapsed(file, isCollapsed)}
        title={isCollapsed ? 'Expand' : 'Collapse'}
        type="button"
      >
        <span className="codiff-chevron-box">
          <span className={isCollapsed ? 'codiff-chevron collapsed' : 'codiff-chevron'} />
        </span>
        <span className="codiff-file-heading">
          <span className="codiff-file-path">{file.path}</span>
          {file.oldPath ? <span className="codiff-file-old-path">{file.oldPath}</span> : null}
          {walkthroughNote ? (
            <span className="codiff-file-note">{walkthroughNote.reason}</span>
          ) : null}
        </span>
        {sectionCount > 1 ? (
          <span className={`codiff-section-badge ${section.kind}`}>
            {sectionLabel[section.kind]}
          </span>
        ) : null}
      </button>
      <DiffLineCountBadge lineCount={lineCount} />
      <div className={`codiff-status-badge ${file.status}`}>{statusLabel[file.status]}</div>
      <button
        className="codiff-open-button"
        disabled={!canOpenFile}
        onClick={() => onOpenFile(file)}
        title={canOpenFile ? 'Open file in editor' : 'Deleted files cannot be opened'}
        type="button"
      >
        Open
      </button>
      <button
        aria-pressed={isViewed}
        className={`codiff-viewed-button${isViewed ? ' active' : ''}`}
        onClick={() => onToggleViewed(file, isViewed)}
        type="button"
      >
        <span aria-hidden className="codiff-viewed-checkbox" />
        Viewed
      </button>
    </div>
  );
}

function ReviewAvatar({
  author,
  identity,
}: {
  author?: PullRequestExistingReviewComment['author'];
  identity: GitIdentity | null;
}) {
  const label = author?.login || identity?.name || identity?.email || 'Git user';
  const avatarUrl = author?.avatarUrl || identity?.gravatarUrl;

  return avatarUrl ? (
    <img alt="" className="review-comment-avatar" draggable={false} src={avatarUrl} />
  ) : (
    <span aria-hidden className="review-comment-avatar fallback">
      {label.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

function CodexAvatar() {
  return (
    <img alt="" className="review-comment-avatar codex" draggable={false} src={codexIconUrl} />
  );
}

const canAskCodexForComment = (comment: ReviewComment) =>
  !comment.isReadOnly && comment.body.trim().length > 0 && comment.codexReply?.status !== 'loading';

const canSubmitCommentToGitHub = (comment: ReviewComment) =>
  !comment.isReadOnly &&
  comment.body.trim().length > 0 &&
  comment.githubSubmit?.status !== 'submitting';

function ReviewAnnotation({
  annotation,
  comments,
  focusCommentId,
  focusCommentRequest,
  identity,
  isPullRequest,
  onAskCodex,
  onCommentBlur,
  onCommentFocus,
  onDeleteComment,
  onSubmitComment,
  onUpdateComment,
}: {
  annotation: DiffLineAnnotation<ReviewAnnotationMetadata>;
  comments: ReadonlyArray<ReviewComment>;
  focusCommentId: string | null;
  focusCommentRequest: number;
  identity: GitIdentity | null;
  isPullRequest: boolean;
  onAskCodex: (commentId: string) => void;
  onCommentBlur: () => void;
  onCommentFocus: (comment: ReviewComment) => void;
  onDeleteComment: (commentId: string) => void;
  onSubmitComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, body: string) => void;
}) {
  const focusTextareaRef = useRef<HTMLTextAreaElement>(null);
  const annotationComments = annotation.metadata.commentIds
    .map((commentId) => comments.find((comment) => comment.id === commentId))
    .filter((comment): comment is ReviewComment => comment != null);
  const hasFocusedComment =
    focusCommentId != null && annotationComments.some((comment) => comment.id === focusCommentId);

  useEffect(() => {
    if (hasFocusedComment) {
      focusTextareaRef.current?.focus();
    }
  }, [focusCommentId, focusCommentRequest, hasFocusedComment]);

  const handleCommentKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>, comment: ReviewComment) => {
      if (event.key === 'Enter' && event.metaKey && !event.shiftKey) {
        if (isPullRequest && canSubmitCommentToGitHub(comment)) {
          event.preventDefault();
          event.stopPropagation();
          onSubmitComment(comment.id);
          return;
        }

        if (!isPullRequest && canAskCodexForComment(comment)) {
          event.preventDefault();
          event.stopPropagation();
          onAskCodex(comment.id);
        }
        return;
      }

      if (event.key !== 'Escape') {
        return;
      }

      if (comment.isReadOnly) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (shouldDiscardReviewCommentOnEscape(comment.body)) {
        onDeleteComment(comment.id);
      }
    },
    [isPullRequest, onAskCodex, onDeleteComment, onSubmitComment],
  );

  if (annotationComments.length === 0) {
    return null;
  }

  return (
    <div className="review-comment-thread">
      {annotationComments.map((comment) => {
        const canAskCodex = canAskCodexForComment(comment);
        const canSubmitComment = canSubmitCommentToGitHub(comment);
        const displayName =
          comment.author?.login || identity?.name || identity?.email || 'Git user';

        return (
          <Fragment key={comment.id}>
            <div className="review-comment">
              <ReviewAvatar author={comment.author} identity={identity} />
              <div className="review-comment-body">
                <div
                  className={`review-comment-header${
                    isPullRequest && !comment.isReadOnly ? ' with-comment-action' : ''
                  }${comment.isReadOnly ? ' read-only' : ''}`}
                >
                  <strong>{displayName}</strong>
                  <span>{getReviewCommentLineLabel(comment)}</span>
                  {!comment.isReadOnly ? (
                    <button
                      className="review-comment-action"
                      disabled={!canAskCodex}
                      onClick={() => onAskCodex(comment.id)}
                      title={canAskCodex ? 'Ask Codex' : 'Write a note before asking Codex'}
                      type="button"
                    >
                      Ask
                    </button>
                  ) : null}
                  {isPullRequest && !comment.isReadOnly ? (
                    <button
                      className="review-comment-action"
                      disabled={!canSubmitComment}
                      onClick={() => onSubmitComment(comment.id)}
                      title={
                        canSubmitComment
                          ? 'Submit comment to GitHub'
                          : 'Write a note before commenting'
                      }
                      type="button"
                    >
                      {comment.githubSubmit?.status === 'submitting' ? 'Sending' : 'Comment'}
                    </button>
                  ) : null}
                  {!comment.isReadOnly ? (
                    <button
                      aria-label="Delete comment"
                      className="review-comment-delete"
                      onClick={() => onDeleteComment(comment.id)}
                      title="Delete comment"
                      type="button"
                    >
                      <span aria-hidden className="review-comment-delete-icon" />
                    </button>
                  ) : null}
                </div>
                <textarea
                  aria-label={`Comment on ${comment.filePath} ${getReviewCommentLineLabel(comment)}`}
                  className={`review-comment-input${comment.isReadOnly ? ' read-only' : ''}`}
                  onBlur={onCommentBlur}
                  onChange={(event) => onUpdateComment(comment.id, event.currentTarget.value)}
                  onFocus={() => onCommentFocus(comment)}
                  onKeyDown={(event) => handleCommentKeyDown(event, comment)}
                  placeholder="Write a review comment…"
                  readOnly={comment.isReadOnly}
                  ref={comment.id === focusCommentId ? focusTextareaRef : undefined}
                  rows={3}
                  spellCheck
                  value={comment.body}
                />
                {comment.githubSubmit?.status === 'error' ? (
                  <div className="review-comment-error">{comment.githubSubmit.error}</div>
                ) : null}
              </div>
            </div>
            {comment.codexReply ? (
              <div className="review-comment codex">
                <CodexAvatar />
                <div className="review-comment-body codex">
                  <div className="review-comment-header codex">
                    <strong>Codex</strong>
                  </div>
                  <div
                    className={`review-comment-codex-reply${
                      comment.codexReply.status === 'loading' ? ' is-loading' : ''
                    }${comment.codexReply.status === 'error' ? ' error' : ''}`}
                  >
                    {comment.codexReply.status === 'loading' ? (
                      <span className="review-comment-codex-loading">Waiting for Codex…</span>
                    ) : (
                      renderMarkdown(comment.codexReply.body ?? comment.codexReply.error ?? '')
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function ReviewCodeView({
  activeSearchMatch,
  collapsed,
  comments,
  files,
  focusCommentId,
  focusCommentRequest,
  forceExpandedPaths,
  gitIdentity,
  isPullRequest,
  itemVersionByPath,
  onAskCodex,
  onCreateComment,
  onDeleteComment,
  onOpenFile,
  onSelectPathFromScroll,
  onSubmitComment,
  onToggleCollapsed,
  onToggleViewed,
  onUpdateComment,
  scrollTarget,
  searchQuery,
  selectedPath,
  showWhitespace,
  viewed,
  walkthroughNotes,
}: {
  activeSearchMatch: DiffSearchMatch | null;
  collapsed: ReadonlySet<string>;
  comments: ReadonlyArray<ReviewComment>;
  files: ReadonlyArray<ChangedFile>;
  focusCommentId: string | null;
  focusCommentRequest: number;
  forceExpandedPaths: ReadonlySet<string>;
  gitIdentity: GitIdentity | null;
  isPullRequest: boolean;
  itemVersionByPath: Readonly<Record<string, number>>;
  onAskCodex: (commentId: string) => void;
  onCreateComment: (comment: Omit<ReviewComment, 'body' | 'id'>) => void;
  onDeleteComment: (commentId: string) => void;
  onOpenFile: (file: ChangedFile) => void;
  onSelectPathFromScroll: (viewer: CodeViewInstance) => void;
  onSubmitComment: (commentId: string) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
  onUpdateComment: (commentId: string, body: string) => void;
  scrollTarget: { path: string; request: number } | null;
  searchQuery: string;
  selectedPath: string | null;
  showWhitespace: boolean;
  viewed: Record<string, string>;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
}) {
  const codeViewRef = useRef<CodeViewHandle<ReviewAnnotationMetadata>>(null);
  const handledScrollRequestRef = useRef<number | null>(null);
  const highlightFrameRef = useRef<number | null>(null);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const stickyHeaderFrameRef = useRef<number | null>(null);
  const commentsBySection = useMemo(() => {
    const map = new Map<string, Array<ReviewComment>>();
    for (const comment of comments) {
      const list = map.get(comment.sectionId) ?? [];
      list.push(comment);
      map.set(comment.sectionId, list);
    }
    return map;
  }, [comments]);

  const { firstItemByPath, itemMetadata, items } = useMemo(() => {
    const nextItems: Array<CodeViewItem<ReviewAnnotationMetadata>> = [];
    const nextFirstItemByPath = new Map<string, string>();
    const nextItemMetadata = new Map<string, CodeViewItemMetadata>();

    for (const file of files) {
      const isViewed = viewed[file.path] === file.fingerprint;
      const isCollapsed = collapsed.has(file.path) && !forceExpandedPaths.has(file.path);
      const visibleSections = getVisibleDiffSections(file, showWhitespace);
      const lineCount = getDiffLineCountFromVisibleSections(visibleSections);
      const sections = isCollapsed ? visibleSections.slice(0, 1) : visibleSections;

      for (const [index, { fileDiff, section }] of sections.entries()) {
        const id = getItemId(section);
        const annotationMap = new Map<string, DiffLineAnnotation<ReviewAnnotationMetadata>>();
        for (const comment of commentsBySection.get(section.id) ?? []) {
          const key = getCommentKey(comment);
          const existing = annotationMap.get(key);
          if (existing) {
            annotationMap.set(key, {
              ...existing,
              metadata: {
                commentIds: [...existing.metadata.commentIds, comment.id],
              },
            });
          } else {
            annotationMap.set(key, {
              lineNumber: comment.lineNumber,
              metadata: {
                commentIds: [comment.id],
              },
              side: comment.side,
            });
          }
        }

        nextItemMetadata.set(id, {
          file,
          isCollapsed,
          isSelected: selectedPath === file.path,
          isViewed,
          lineCount,
          section,
          sectionCount: file.sections.length,
          walkthroughNote: walkthroughNotes.get(file.path),
        });
        nextFirstItemByPath.set(file.path, nextFirstItemByPath.get(file.path) ?? id);
        nextItems.push({
          annotations: [...annotationMap.values()],
          collapsed: isCollapsed,
          fileDiff,
          id,
          type: 'diff',
          version: getItemVersion(
            `${itemVersionByPath[file.path] ?? 0}:${file.fingerprint}:${section.id}:${
              isCollapsed ? 'collapsed' : 'open'
            }:${isViewed ? 'viewed' : 'pending'}:${index}:${
              selectedPath === file.path ? 'selected' : 'idle'
            }:${walkthroughNotes.get(file.path)?.reason ?? ''}:${
              showWhitespace ? 'ws' : 'ignore-ws'
            }:${getReviewCommentsDigest(commentsBySection.get(section.id) ?? [])}`,
          ),
        });
      }
    }

    return {
      firstItemByPath: nextFirstItemByPath,
      itemMetadata: nextItemMetadata,
      items: nextItems,
    };
  }, [
    collapsed,
    commentsBySection,
    files,
    forceExpandedPaths,
    itemVersionByPath,
    selectedPath,
    showWhitespace,
    viewed,
    walkthroughNotes,
  ]);

  const codeViewOptions: CodeViewOptions<ReviewAnnotationMetadata> = useMemo(
    () =>
      ({
        collapsedContextThreshold: diffCollapsedContextThreshold,
        diffIndicators: 'bars',
        diffStyle: 'split',
        enableGutterUtility: true,
        enableLineSelection: true,
        expandUnchanged: false,
        expansionLineCount: diffContextExpansionLineCount,
        hunkSeparators: 'line-info-basic',
        itemMetrics:
          walkthroughNotes.size > 0 ? codeViewItemMetricsWithWalkthrough : codeViewItemMetrics,
        layout: codeViewLayout,
        lineDiffType: 'char',
        lineHoverHighlight: 'both',
        onGutterUtilityClick: (range, context) => {
          const meta = itemMetadata.get(context.item.id);
          if (!meta || meta.isCollapsed) {
            return;
          }
          const startSide = range.side ?? range.endSide ?? 'additions';
          const endSide = range.endSide ?? startSide;
          if (startSide !== endSide) {
            window.alert('Review comments cannot span both sides of a split diff.');
            return;
          }
          const start = Math.min(range.start, range.end);
          const end = Math.max(range.start, range.end);
          onCreateComment({
            filePath: meta.file.path,
            lineNumber: end,
            sectionId: meta.section.id,
            side: endSide,
            ...(end !== start ? { startLineNumber: start } : {}),
          });
        },
        onLineClick: (line, context) => {
          if (isInteractiveReviewEvent(line.event)) {
            return;
          }

          const meta = itemMetadata.get(context.item.id);
          if (!meta || meta.isCollapsed) {
            return;
          }

          const side = 'annotationSide' in line ? line.annotationSide : null;
          if (!side) {
            return;
          }

          onCreateComment({
            filePath: meta.file.path,
            lineNumber: line.lineNumber,
            sectionId: meta.section.id,
            side,
          });
        },
        stickyHeaders: true,
        theme: {
          dark: 'Dunkel',
          light: 'Licht',
        },
        themeType: 'system',
        tokenizeMaxLength: 100_000,
        unsafeCSS: codeViewUnsafeCSS,
      }) satisfies CodeViewOptions<ReviewAnnotationMetadata>,
    [itemMetadata, onCreateComment, walkthroughNotes.size],
  );

  const highlightCommentLines = useCallback((comment: ReviewComment) => {
    setSelectedLines(getReviewCommentLineSelection(comment));
  }, []);

  const clearCommentLineHighlight = useCallback(() => {
    codeViewRef.current?.clearSelectedLines();
    setSelectedLines(null);
  }, []);

  const deleteComment = useCallback(
    (commentId: string) => {
      clearCommentLineHighlight();
      onDeleteComment(commentId);
    },
    [clearCommentLineHighlight, onDeleteComment],
  );

  const workerPoolOptions = useMemo(
    () => ({
      poolSize: Math.min(
        maxWorkerThreads,
        Math.max(1, navigator.hardwareConcurrency || maxWorkerThreads),
      ),
      workerFactory: () =>
        new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), {
          type: 'module',
        }),
    }),
    [],
  );

  const scrollItemHeaderIntoView = useCallback((itemId: string) => {
    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || viewer.getTopForItem(itemId) == null) {
      return false;
    }

    handle.scrollTo({
      behavior: 'instant',
      id: itemId,
      offset: DEFAULT_PADDING,
      type: 'item',
    });

    return true;
  }, []);

  useEffect(() => {
    if (!scrollTarget || handledScrollRequestRef.current === scrollTarget.request) {
      return;
    }

    let frame: number | null = null;
    let attempts = 0;
    let canceled = false;

    const tryScroll = () => {
      if (canceled || handledScrollRequestRef.current === scrollTarget.request) {
        return;
      }

      const itemId = firstItemByPath.get(scrollTarget.path);
      if (itemId && scrollItemHeaderIntoView(itemId)) {
        handledScrollRequestRef.current = scrollTarget.request;
        return;
      }

      if (attempts < 6) {
        attempts += 1;
        frame = window.requestAnimationFrame(tryScroll);
      }
    };

    tryScroll();

    return () => {
      canceled = true;
      if (frame != null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [firstItemByPath, scrollItemHeaderIntoView, scrollTarget]);

  const scheduleSearchHighlights = useCallback(() => {
    const viewer = codeViewRef.current?.getInstance();
    if (!viewer) {
      return;
    }

    if (highlightFrameRef.current != null) {
      window.cancelAnimationFrame(highlightFrameRef.current);
    }

    highlightFrameRef.current = window.requestAnimationFrame(() => {
      highlightFrameRef.current = null;
      applySearchHighlights(viewer.getRenderedItems(), searchQuery, activeSearchMatch);
    });
  }, [activeSearchMatch, searchQuery]);

  const scheduleStickyHeaderStateUpdate = useCallback((viewer?: CodeViewInstance) => {
    const nextViewer = viewer ?? codeViewRef.current?.getInstance();
    if (!nextViewer) {
      return;
    }

    if (stickyHeaderFrameRef.current != null) {
      window.cancelAnimationFrame(stickyHeaderFrameRef.current);
    }

    stickyHeaderFrameRef.current = window.requestAnimationFrame(() => {
      stickyHeaderFrameRef.current = null;
      updateStickyHeaderState(nextViewer);
    });
  }, []);

  useEffect(
    () => () => {
      if (highlightFrameRef.current != null) {
        window.cancelAnimationFrame(highlightFrameRef.current);
      }
      if (stickyHeaderFrameRef.current != null) {
        window.cancelAnimationFrame(stickyHeaderFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    scheduleSearchHighlights();
    scheduleStickyHeaderStateUpdate();
  }, [items, scheduleSearchHighlights, scheduleStickyHeaderStateUpdate]);

  useEffect(() => {
    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || !activeSearchMatch) {
      return;
    }

    if (activeSearchMatch.lineNumber == null) {
      handle.scrollTo({
        align: 'center',
        behavior: 'smooth-auto',
        id: activeSearchMatch.itemId,
        type: 'item',
      });
    } else {
      handle.scrollTo({
        align: 'center',
        behavior: 'smooth-auto',
        id: activeSearchMatch.itemId,
        lineNumber: activeSearchMatch.lineNumber,
        offset: DEFAULT_PADDING,
        side: activeSearchMatch.side,
        type: 'line',
      });
    }

    scheduleSearchHighlights();
  }, [activeSearchMatch, scheduleSearchHighlights]);

  const renderCustomHeader = useCallback(
    (item: CodeViewItem<ReviewAnnotationMetadata>) => {
      const meta = itemMetadata.get(item.id);
      return meta ? (
        <CodeViewHeader
          meta={meta}
          onOpenFile={onOpenFile}
          onToggleCollapsed={onToggleCollapsed}
          onToggleViewed={onToggleViewed}
        />
      ) : null;
    },
    [itemMetadata, onOpenFile, onToggleCollapsed, onToggleViewed],
  );

  const renderAnnotation = useCallback(
    (
      annotation: DiffLineAnnotation<ReviewAnnotationMetadata>,
      item: CodeViewItem<ReviewAnnotationMetadata>,
    ) =>
      item.type === 'diff' ? (
        <ReviewAnnotation
          annotation={annotation}
          comments={comments}
          focusCommentId={focusCommentId}
          focusCommentRequest={focusCommentRequest}
          identity={gitIdentity}
          isPullRequest={isPullRequest}
          onAskCodex={onAskCodex}
          onCommentBlur={clearCommentLineHighlight}
          onCommentFocus={highlightCommentLines}
          onDeleteComment={deleteComment}
          onSubmitComment={onSubmitComment}
          onUpdateComment={onUpdateComment}
        />
      ) : null,
    [
      comments,
      clearCommentLineHighlight,
      deleteComment,
      focusCommentId,
      focusCommentRequest,
      gitIdentity,
      highlightCommentLines,
      isPullRequest,
      onAskCodex,
      onSubmitComment,
      onUpdateComment,
    ],
  );

  const handleScroll = useCallback(
    (_scrollTop: number, viewer: CodeViewInstance) => {
      onSelectPathFromScroll(viewer);
      scheduleSearchHighlights();
      scheduleStickyHeaderStateUpdate(viewer);
    },
    [onSelectPathFromScroll, scheduleSearchHighlights, scheduleStickyHeaderStateUpdate],
  );

  return (
    <WorkerPoolContextProvider
      highlighterOptions={workerHighlighterOptions}
      poolOptions={workerPoolOptions}
    >
      <CodeView
        className="code-view"
        items={items}
        onScroll={handleScroll}
        onSelectedLinesChange={setSelectedLines}
        options={codeViewOptions}
        ref={codeViewRef}
        renderAnnotation={renderAnnotation}
        renderCustomHeader={renderCustomHeader}
        selectedLines={selectedLines}
      />
    </WorkerPoolContextProvider>
  );
}

function ReviewSourceLoading() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="review-source-loading loading pulse italic" role="status">
      {visible ? 'Thinking…' : null}
    </div>
  );
}

function RepositoryChangeBanner({ visible }: { visible: boolean }) {
  return (
    <div aria-live="polite" className={`repository-change-banner${visible ? ' visible' : ''}`}>
      <span>Local changes detected,</span>
      <button onClick={() => window.location.reload()} type="button">
        {getReloadShortcutLabel()} to reload.
      </button>
    </div>
  );
}

function FirstRunPanel({
  installing,
  onInstallTerminalHelper,
}: {
  installing: boolean;
  onInstallTerminalHelper: () => void;
}) {
  return (
    <>
      <strong>Open a Git repository</strong>
      <p>
        Install the terminal helper, then run{' '}
        <code className="walkthrough-inline-code">codiff</code> from a Git repository in Terminal.
      </p>
      <p>
        You can also choose <span className="empty-panel-menu-path">File → Open Folder…</span> to
        open a Git repository.
      </p>
      <div className="empty-panel-actions">
        <button disabled={installing} onClick={onInstallTerminalHelper} type="button">
          {installing ? 'Installing...' : 'Install Terminal Helper'}
        </button>
      </div>
    </>
  );
}

function RepositoryLoadErrorPanel({ error }: { error: RepositoryLoadError }) {
  if (error.kind === 'not-a-repository') {
    return (
      <>
        <strong>No Git repository found</strong>
        <p>
          Codiff was opened outside a Git repository. Run{' '}
          <code className="walkthrough-inline-code">codiff</code> from inside a repo, or choose{' '}
          <span className="empty-panel-menu-path">File → Open Folder…</span> to open one.
        </p>
      </>
    );
  }

  return (
    <>
      <strong>Unable to read repository</strong>
      <p>{error.message}</p>
    </>
  );
}

function DiffSearchPanel({
  activeIndex,
  focusRequest,
  matchCount,
  onChange,
  onClose,
  onNext,
  onPrevious,
  query,
  visible,
}: {
  activeIndex: number;
  focusRequest: number;
  matchCount: number;
  onChange: (query: string) => void;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  query: string;
  visible: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [focusRequest, visible]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) {
          onPrevious();
        } else {
          onNext();
        }
      }
    },
    [onClose, onNext, onPrevious],
  );

  return (
    <div className={`diff-search-panel${visible ? ' visible' : ''}`}>
      <input
        aria-label="Search diffs"
        className="diff-search-input"
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in diffs"
        ref={inputRef}
        spellCheck={false}
        type="search"
        value={query}
      />
      <span className="diff-search-count">
        {query.trim() ? (matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : '0/0') : ''}
      </span>
      <button
        aria-label="Previous match"
        disabled={matchCount === 0}
        onClick={onPrevious}
        title="Previous match"
        type="button"
      >
        <span aria-hidden className="diff-search-chevron up" />
      </button>
      <button
        aria-label="Next match"
        disabled={matchCount === 0}
        onClick={onNext}
        title="Next match"
        type="button"
      >
        <span aria-hidden className="diff-search-chevron down" />
      </button>
      <button aria-label="Close search" onClick={onClose} title="Close" type="button">
        <span aria-hidden className="diff-search-close-icon" />
      </button>
    </div>
  );
}

function CopyCommentsButton({
  comments,
  files,
  showWhitespace,
}: {
  comments: ReadonlyArray<ReviewComment>;
  files: ReadonlyArray<ChangedFile>;
  showWhitespace: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const pendingCommentCount = comments.filter(
    (comment) => !comment.isReadOnly && comment.body.trim(),
  ).length;

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  const copyComments = useCallback(async () => {
    const markdown = buildReviewCommentsMarkdown(files, comments, showWhitespace);
    if (!markdown) {
      return;
    }

    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    if (copiedTimerRef.current != null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 2000);
  }, [comments, files, showWhitespace]);

  if (pendingCommentCount === 0) {
    return null;
  }

  return (
    <button
      aria-label={`Copy ${pendingCommentCount} review ${
        pendingCommentCount === 1 ? 'comment' : 'comments'
      }`}
      className={`copy-comments-button${copied ? ' copied' : ''}`}
      onClick={() => void copyComments()}
      title="Copy review comments"
      type="button"
    >
      <span aria-hidden className={copied ? 'copy-comments-icon check' : 'copy-comments-icon'} />
    </button>
  );
}

function PullRequestReviewButtons({
  disabled,
  onSubmitReview,
  submittingEvent,
}: {
  disabled: boolean;
  onSubmitReview: (event: PullRequestReviewEvent) => void;
  submittingEvent: PullRequestReviewEvent | null;
}) {
  return (
    <>
      <button
        aria-label="Approve pull request"
        className="review-submit-button approve"
        disabled={disabled}
        onClick={() => onSubmitReview('APPROVE')}
        title="Approve pull request"
        type="button"
      >
        <span aria-hidden className="review-submit-icon approve" />
      </button>
      <button
        aria-label="Request changes"
        className="review-submit-button request-changes"
        disabled={disabled}
        onClick={() => onSubmitReview('REQUEST_CHANGES')}
        title="Request changes"
        type="button"
      >
        <span
          aria-hidden
          className={`review-submit-icon request-changes${
            submittingEvent === 'REQUEST_CHANGES' ? ' submitting' : ''
          }`}
        />
      </button>
    </>
  );
}

export default function App() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeDiffSearchMatchIndex, setActiveDiffSearchMatchIndex] = useState(0);
  const [diffSearchFocusRequest, setDiffSearchFocusRequest] = useState(0);
  const [diffSearchQuery, setDiffSearchQuery] = useState('');
  const [diffSearchVisible, setDiffSearchVisible] = useState(false);
  const [loadError, setLoadError] = useState<RepositoryLoadError | null>(null);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [focusCommentRequest, setFocusCommentRequest] = useState(0);
  const [gitIdentity, setGitIdentity] = useState<GitIdentity | null>(null);
  const [historyEntries, setHistoryEntries] = useState<ReadonlyArray<HistoryEntry>>([]);
  const [historyHasMore, setHistoryHasMore] = useState(true);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPullRequestSource, setHistoryPullRequestSource] =
    useState<PullRequestSource | null>(null);
  const [itemVersionByPath, setItemVersionByPath] = useState<Record<string, number>>({});
  const [localChangesDetected, setLocalChangesDetected] = useState(false);
  const [launchOptions, setLaunchOptions] = useState<CodiffLaunchOptions>(defaultLaunchOptions);
  const [preferences, setPreferences] = useState<CodiffPreferences>(defaultPreferences);
  const [reviewComments, setReviewComments] = useState<ReadonlyArray<ReviewComment>>([]);
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ path: string; request: number } | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [pendingSource, setPendingSource] = useState<ReviewSource | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('tree');
  const [state, setState] = useState<RepositoryState | null>(null);
  const [terminalHelperInstalling, setTerminalHelperInstalling] = useState(false);
  const [terminalHelperStatus, setTerminalHelperStatus] = useState<TerminalHelperStatus>(
    defaultTerminalHelperStatus,
  );
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null);
  const [walkthroughError, setWalkthroughError] = useState<string | null>(null);
  const [walkthroughLoading, setWalkthroughLoading] = useState(false);
  const [walkthroughUnread, setWalkthroughUnread] = useState(false);
  const historyRequestRef = useRef(0);
  const loadingSectionKeysRef = useRef<Set<string>>(new Set());
  const programmaticScrollPathRef = useRef<string | null>(null);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const sourceSessionsRef = useRef<Map<string, SourceSession>>(new Map());
  const stateRef = useRef<RepositoryState | null>(null);
  const collapsedRef = useRef<Set<string>>(new Set());
  const preferencesRef = useRef<CodiffPreferences>(defaultPreferences);
  const reviewCommentsRef = useRef<ReadonlyArray<ReviewComment>>([]);
  const selectedPathRef = useRef<string | null>(null);
  const sidebarModeRef = useRef<SidebarMode>('tree');
  const sourceRequestRef = useRef(0);
  const viewedRef = useRef<Record<string, string>>({});
  const walkthroughRef = useRef<Walkthrough | null>(null);
  const walkthroughErrorRef = useRef<string | null>(null);

  const bumpItemVersion = useCallback((path: string) => {
    setItemVersionByPath((current) => ({
      ...current,
      [path]: (current[path] ?? 0) + 1,
    }));
  }, []);

  const saveCurrentSourceSession = useCallback(() => {
    const currentState = stateRef.current;
    if (!currentState) {
      return;
    }

    sourceSessionsRef.current.set(getSourceKey(currentState.source), {
      collapsed: new Set(collapsedRef.current),
      reviewComments: reviewCommentsRef.current,
      selectedPath: selectedPathRef.current,
      viewed: viewedRef.current,
      walkthrough: walkthroughRef.current,
      walkthroughError: walkthroughErrorRef.current,
    });
  }, []);

  useEffect(() => {
    let canceled = false;

    const load = async () => {
      const nextLaunchOptions = await window.codiff.getLaunchOptions();
      if (canceled) {
        return;
      }
      setLaunchOptions(nextLaunchOptions);

      const nextTerminalHelperStatus = await window.codiff
        .getTerminalHelperStatus()
        .catch(() => defaultTerminalHelperStatus);
      if (canceled) {
        return;
      }
      setTerminalHelperStatus(nextTerminalHelperStatus);

      const [nextState, history] = await Promise.all([
        window.codiff.getRepositoryState(),
        window.codiff.getRepositoryHistory(HISTORY_PAGE_SIZE),
      ]);

      if (canceled) {
        return;
      }

      const orderedState = {
        ...nextState,
        files: sortFiles(nextState.files),
      };
      const shouldLoadWalkthrough = nextLaunchOptions.walkthrough && orderedState.files.length > 0;
      const shouldStartInHistory =
        orderedState.source.type === 'working-tree' && orderedState.files.length === 0;

      setLaunchOptions({
        ...nextLaunchOptions,
        walkthrough: shouldLoadWalkthrough,
      });
      setSidebarMode(
        shouldLoadWalkthrough ? 'walkthrough' : shouldStartInHistory ? 'history' : 'tree',
      );
      setWalkthroughLoading(shouldLoadWalkthrough);

      const walkthroughResult = shouldLoadWalkthrough
        ? await window.codiff.getWalkthrough(orderedState.source)
        : null;

      if (canceled) {
        return;
      }

      const nextWalkthrough =
        walkthroughResult?.status === 'ready' ? walkthroughResult.walkthrough : null;

      if (walkthroughResult?.status === 'unavailable') {
        setWalkthroughError(walkthroughResult.reason);
        setSidebarMode('tree');
      } else {
        setWalkthroughError(null);
      }

      setWalkthrough(nextWalkthrough);
      setWalkthroughLoading(false);

      const nextViewed =
        orderedState.source.type === 'working-tree' ? readViewed(orderedState.root) : {};
      const initialFiles = nextLaunchOptions.walkthrough
        ? orderFilesByWalkthrough(orderedState.files, nextWalkthrough)
        : orderedState.files;

      setHistoryEntries(history.entries);
      setHistoryHasMore(history.entries.length >= HISTORY_PAGE_SIZE);
      setHistoryLimit(HISTORY_PAGE_SIZE);
      setHistoryPullRequestSource(
        orderedState.source.type === 'pull-request' ? orderedState.source : null,
      );
      setState(orderedState);
      setLoadError(null);
      setCollapsed(
        new Set(
          orderedState.files
            .filter((file) => nextViewed[file.path] === file.fingerprint)
            .map((file) => file.path),
        ),
      );
      setItemVersionByPath({});
      setFocusCommentId(null);
      setFocusCommentRequest(0);
      setReviewComments(getReviewCommentsFromState(orderedState));
      setViewed(nextViewed);
      setSelectedPath((current) => current ?? initialFiles[0]?.path ?? null);
    };

    load().catch((error: unknown) => {
      if (canceled) {
        return;
      }

      setLoadError(getRepositoryLoadError(error));
      setWalkthroughLoading(false);
    });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(
    () =>
      window.codiff.onRepositoryChanged(() => {
        setLocalChangesDetected(true);
      }),
    [],
  );

  useEffect(() => {
    let canceled = false;

    window.codiff
      .getGitIdentity()
      .then((identity) => {
        if (!canceled) {
          setGitIdentity(identity);
        }
      })
      .catch(() => {
        if (!canceled) {
          setGitIdentity(null);
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!state || state.source.type !== 'working-tree' || !selectedPath) {
      return;
    }

    const selectedFile = state.files.find((file) => file.path === selectedPath);
    if (!selectedFile) {
      return;
    }

    const deferredSections = selectedFile.sections.filter(
      (section) => section.loadState === 'deferred' && section.summary?.canLoad !== false,
    );

    if (!deferredSections.length) {
      return;
    }

    let canceled = false;
    const sourceKey = getSourceKey(state.source);

    for (const section of deferredSections) {
      const key = `${state.root}:${section.id}`;
      if (loadingSectionKeysRef.current.has(key)) {
        continue;
      }

      loadingSectionKeysRef.current.add(key);
      window.codiff
        .getDiffSectionContent({
          force: true,
          kind: section.kind,
          path: selectedFile.path,
          source: state.source,
        })
        .then((loadedSection) => {
          if (canceled) {
            return;
          }

          setState((current) => {
            if (
              !current ||
              current.root !== state.root ||
              getSourceKey(current.source) !== sourceKey
            ) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((file) =>
                file.path === selectedFile.path
                  ? {
                      ...file,
                      sections: file.sections.map((candidate) =>
                        candidate.id === section.id ? loadedSection : candidate,
                      ),
                    }
                  : file,
              ),
            };
          });
          bumpItemVersion(selectedFile.path);
        })
        .catch(() => {
          if (!canceled) {
            setState((current) => {
              if (
                !current ||
                current.root !== state.root ||
                getSourceKey(current.source) !== sourceKey
              ) {
                return current;
              }

              return {
                ...current,
                files: current.files.map((file) =>
                  file.path === selectedFile.path
                    ? {
                        ...file,
                        sections: file.sections.map((candidate) =>
                          candidate.id === section.id
                            ? {
                                ...candidate,
                                loadState: 'error',
                                summary: {
                                  canLoad: false,
                                  reason: 'Codiff could not load this file.',
                                },
                              }
                            : candidate,
                        ),
                      }
                    : file,
                ),
              };
            });
            bumpItemVersion(selectedFile.path);
          }
        })
        .finally(() => {
          loadingSectionKeysRef.current.delete(key);
        });
    }

    return () => {
      canceled = true;
    };
  }, [bumpItemVersion, selectedPath, state]);

  useEffect(() => {
    if (!state || state.source.type !== 'working-tree' || !diffSearchQuery.trim()) {
      return;
    }

    const searchableFiles = sortFiles(state.files).filter(
      (file) =>
        fuzzyMatches(file.path, fileSearchQuery) &&
        fileHasVisibleDiff(file, preferences.showWhitespace),
    );
    const requests = searchableFiles.flatMap((file) =>
      file.sections
        .filter((section) => section.loadState === 'deferred' && section.summary?.canLoad !== false)
        .map((section) => ({
          file,
          section,
        })),
    );

    if (!requests.length) {
      return;
    }

    let canceled = false;
    let cursor = 0;
    const sourceKey = getSourceKey(state.source);

    const loadNext = async (): Promise<void> => {
      if (canceled) {
        return;
      }

      const request = requests[cursor];
      cursor += 1;
      if (!request) {
        return;
      }

      const key = `${state.root}:${request.section.id}`;
      if (loadingSectionKeysRef.current.has(key)) {
        return loadNext();
      }

      loadingSectionKeysRef.current.add(key);

      try {
        const loadedSection = await window.codiff.getDiffSectionContent({
          force: true,
          kind: request.section.kind,
          path: request.file.path,
          source: state.source,
        });

        if (!canceled) {
          setState((current) => {
            if (
              !current ||
              current.root !== state.root ||
              getSourceKey(current.source) !== sourceKey
            ) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((file) =>
                file.path === request.file.path
                  ? {
                      ...file,
                      sections: file.sections.map((candidate) =>
                        candidate.id === request.section.id ? loadedSection : candidate,
                      ),
                    }
                  : file,
              ),
            };
          });
          bumpItemVersion(request.file.path);
        }
      } catch {
        if (!canceled) {
          setState((current) => {
            if (
              !current ||
              current.root !== state.root ||
              getSourceKey(current.source) !== sourceKey
            ) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((file) =>
                file.path === request.file.path
                  ? {
                      ...file,
                      sections: file.sections.map((candidate) =>
                        candidate.id === request.section.id
                          ? {
                              ...candidate,
                              loadState: 'error',
                              summary: {
                                canLoad: false,
                                reason: 'Codiff could not load this file.',
                              },
                            }
                          : candidate,
                      ),
                    }
                  : file,
              ),
            };
          });
          bumpItemVersion(request.file.path);
        }
      } finally {
        loadingSectionKeysRef.current.delete(key);
      }

      return loadNext();
    };

    void Promise.all(Array.from({ length: Math.min(3, requests.length) }, () => loadNext()));

    return () => {
      canceled = true;
    };
  }, [bumpItemVersion, diffSearchQuery, fileSearchQuery, preferences.showWhitespace, state]);

  useEffect(() => {
    let canceled = false;

    window.codiff.getPreferences().then((nextPreferences) => {
      if (!canceled) {
        setPreferences(nextPreferences);
      }
    });

    const removeListener = window.codiff.onPreferencesChanged((nextPreferences) => {
      setPreferences(nextPreferences);
    });

    return () => {
      canceled = true;
      removeListener();
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (preferences.theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', preferences.theme);
    }
  }, [preferences.theme]);

  useEffect(
    () => () => {
      if (programmaticScrollTimerRef.current != null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    sidebarModeRef.current = sidebarMode;
  }, [sidebarMode]);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    reviewCommentsRef.current = reviewComments;
  }, [reviewComments]);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    const removeListener = window.codiff.onCopyPendingCommentsRequest(() => {
      const currentState = stateRef.current;
      if (!currentState) {
        return '';
      }

      return buildReviewCommentsMarkdown(
        currentState.files,
        reviewCommentsRef.current,
        preferencesRef.current.showWhitespace,
      );
    });
    return removeListener;
  }, []);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    viewedRef.current = viewed;
  }, [viewed]);

  useEffect(() => {
    walkthroughRef.current = walkthrough;
  }, [walkthrough]);

  useEffect(() => {
    walkthroughErrorRef.current = walkthroughError;
  }, [walkthroughError]);

  const showWhitespace = preferences.showWhitespace;
  const walkthroughNotes = useMemo(() => getWalkthroughNotes(walkthrough), [walkthrough]);
  const orderedFiles = useMemo(
    () =>
      state
        ? sidebarMode === 'walkthrough'
          ? orderFilesByWalkthrough(sortFiles(state.files), walkthrough)
          : sortFiles(state.files)
        : [],
    [sidebarMode, state, walkthrough],
  );
  const fileFilteredFiles = useMemo(
    () =>
      state
        ? orderedFiles.filter(
            (file) =>
              fuzzyMatches(file.path, fileSearchQuery) && fileHasVisibleDiff(file, showWhitespace),
          )
        : [],
    [fileSearchQuery, orderedFiles, showWhitespace, state],
  );

  const diffSearchResults = useMemo(
    () =>
      diffSearchQuery.trim()
        ? fileFilteredFiles
            .map((file) => getDiffSearchResult(file, showWhitespace, diffSearchQuery))
            .filter((result): result is DiffSearchResult => result != null)
        : [],
    [diffSearchQuery, fileFilteredFiles, showWhitespace],
  );

  const diffSearchMatches = useMemo(
    () => diffSearchResults.flatMap((result) => result.matches),
    [diffSearchResults],
  );

  const diffSearchMatchPathSet = useMemo(
    () => new Set(diffSearchResults.map((result) => result.file.path)),
    [diffSearchResults],
  );

  const visibleFiles = useMemo(
    () =>
      diffSearchQuery.trim()
        ? fileFilteredFiles.filter((file) => diffSearchMatchPathSet.has(file.path))
        : fileFilteredFiles,
    [diffSearchMatchPathSet, diffSearchQuery, fileFilteredFiles],
  );

  const effectiveActiveDiffSearchMatchIndex =
    diffSearchMatches.length === 0
      ? 0
      : Math.min(activeDiffSearchMatchIndex, diffSearchMatches.length - 1);
  const activeDiffSearchMatch = diffSearchMatches[effectiveActiveDiffSearchMatchIndex] ?? null;

  const openDiffSearch = useCallback(() => {
    setDiffSearchVisible(true);
    setDiffSearchFocusRequest((current) => current + 1);
  }, []);

  const closeDiffSearch = useCallback(() => {
    setDiffSearchVisible(false);
    setDiffSearchQuery('');
    setActiveDiffSearchMatchIndex(0);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDiffSearchShortcut(event)) {
        event.preventDefault();
        openDiffSearch();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openDiffSearch]);

  useEffect(() => window.codiff.onFindInDiffs(openDiffSearch), [openDiffSearch]);

  const updateDiffSearchQuery = useCallback((query: string) => {
    setDiffSearchQuery(query);
    setDiffSearchVisible(true);
    setActiveDiffSearchMatchIndex(0);
  }, []);

  const loadMoreHistory = useCallback(() => {
    if (historyLoading || !historyHasMore) {
      return;
    }

    const nextLimit = historyLimit + HISTORY_PAGE_SIZE;
    const request = historyRequestRef.current + 1;
    historyRequestRef.current = request;
    setHistoryLoading(true);
    window.codiff
      .getRepositoryHistory(nextLimit)
      .then((history) => {
        if (historyRequestRef.current !== request) {
          return;
        }

        setHistoryEntries(history.entries);
        setHistoryLimit(nextLimit);
        setHistoryHasMore(history.entries.length >= nextLimit);
      })
      .catch(() => {
        if (historyRequestRef.current === request) {
          setHistoryHasMore(false);
        }
      })
      .finally(() => {
        if (historyRequestRef.current === request) {
          setHistoryLoading(false);
        }
      });
  }, [historyHasMore, historyLimit, historyLoading]);

  const moveDiffSearchMatch = useCallback(
    (direction: 1 | -1) => {
      setDiffSearchVisible(true);
      setActiveDiffSearchMatchIndex((current) => {
        const matchCount = diffSearchMatches.length;
        if (matchCount === 0) {
          return 0;
        }

        return (current + direction + matchCount) % matchCount;
      });
    },
    [diffSearchMatches.length],
  );

  const selectPath = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const activatePath = useCallback((path: string) => {
    setSelectedPath(path);
    setScrollTarget((current) => ({
      path,
      request: (current?.request ?? 0) + 1,
    }));
    programmaticScrollPathRef.current = path;
    if (programmaticScrollTimerRef.current != null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }

    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollPathRef.current = null;
      programmaticScrollTimerRef.current = null;
    }, 1200);
  }, []);

  const selectSource = useCallback(
    (source: ReviewSource) => {
      const currentState = stateRef.current;
      const sourceKey = getSourceKey(source);
      const currentDisplayKey = getSourceKey(pendingSource ?? currentState?.source ?? source);
      if (currentDisplayKey === sourceKey) {
        return;
      }

      saveCurrentSourceSession();
      const request = sourceRequestRef.current + 1;
      sourceRequestRef.current = request;
      setPendingSource(source);
      setLoadError(null);
      setFocusCommentId(null);
      setFocusCommentRequest(0);
      setDiffSearchQuery('');
      setActiveDiffSearchMatchIndex(0);
      setScrollTarget(null);

      window.codiff
        .getRepositoryState(source)
        .then((nextState) => {
          if (sourceRequestRef.current !== request) {
            return;
          }

          const orderedState = {
            ...nextState,
            files: sortFiles(nextState.files),
          };
          const session = sourceSessionsRef.current.get(getSourceKey(orderedState.source));
          const nextViewed =
            session?.viewed ??
            (orderedState.source.type === 'working-tree' ? readViewed(orderedState.root) : {});
          const nextSelectedPath =
            session?.selectedPath &&
            orderedState.files.some((file) => file.path === session.selectedPath)
              ? session.selectedPath
              : (orderedState.files[0]?.path ?? null);
          const nextCollapsed =
            session?.collapsed ??
            new Set(
              orderedState.files
                .filter((file) => nextViewed[file.path] === file.fingerprint)
                .map((file) => file.path),
            );

          setState(orderedState);
          if (orderedState.source.type === 'pull-request') {
            setHistoryPullRequestSource(orderedState.source);
          }
          setCollapsed(new Set(nextCollapsed));
          setItemVersionByPath({});
          setReviewComments(session?.reviewComments ?? getReviewCommentsFromState(orderedState));
          setViewed(nextViewed);
          setSelectedPath(nextSelectedPath);
          setWalkthrough(session?.walkthrough ?? null);
          setWalkthroughError(session?.walkthroughError ?? null);
          setWalkthroughLoading(false);
          setWalkthroughUnread(false);
          setPendingSource(null);
        })
        .catch((error: unknown) => {
          if (sourceRequestRef.current === request) {
            setLoadError(getRepositoryLoadError(error));
            setWalkthroughLoading(false);
            setPendingSource(null);
          }
        });
    },
    [pendingSource, saveCurrentSourceSession],
  );

  const changeSidebarMode = useCallback(
    (mode: SidebarMode) => {
      if (mode === 'tree') {
        setSidebarMode('tree');
        return;
      }

      if (mode === 'history') {
        setSidebarMode('history');
        return;
      }

      setSidebarMode('walkthrough');
      setWalkthroughUnread(false);
      if (walkthrough || walkthroughLoading || !state) {
        return;
      }
      if (state.files.length === 0) {
        setWalkthrough(null);
        setWalkthroughError(null);
        setWalkthroughLoading(false);
        return;
      }

      const sourceKey = getSourceKey(state.source);
      setWalkthroughLoading(true);
      setWalkthroughError(null);
      window.codiff
        .getWalkthrough(state.source)
        .then((result) => {
          if (getSourceKey(stateRef.current?.source ?? state.source) !== sourceKey) {
            return;
          }

          if (result.status === 'ready') {
            setWalkthrough(result.walkthrough);
            if (sidebarModeRef.current === 'walkthrough') {
              setSidebarMode('walkthrough');
            } else {
              setWalkthroughUnread(true);
            }
          } else {
            setWalkthroughError(result.reason);
            if (sidebarModeRef.current === 'walkthrough') {
              setSidebarMode('tree');
            }
          }
        })
        .catch((error: unknown) => {
          if (getSourceKey(stateRef.current?.source ?? state.source) !== sourceKey) {
            return;
          }

          setWalkthroughError(error instanceof Error ? error.message : String(error));
          if (sidebarModeRef.current === 'walkthrough') {
            setSidebarMode('tree');
          }
        })
        .finally(() => {
          if (getSourceKey(stateRef.current?.source ?? state.source) === sourceKey) {
            setWalkthroughLoading(false);
          }
        });
    },
    [state, walkthrough, walkthroughLoading],
  );

  const toggleCollapsed = useCallback(
    (file: ChangedFile, isCollapsed: boolean) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (isCollapsed) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion],
  );

  const openFile = useCallback((file: ChangedFile) => {
    void window.codiff.openFile(file.path).catch(() => {});
  }, []);

  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      if (!visibleFiles.length) {
        return;
      }

      const scrollTop = viewer.getScrollTop();
      const activationTop = scrollTop + DEFAULT_PADDING;
      let nextPath = visibleFiles[0]?.path ?? null;
      let nextDistance = Number.NEGATIVE_INFINITY;

      for (const file of visibleFiles) {
        const section = getFirstVisibleSection(file, showWhitespace);
        const itemId = section ? getItemId(section) : null;
        const itemTop = itemId ? viewer.getTopForItem(itemId) : undefined;
        if (itemTop == null) {
          continue;
        }

        const distance = itemTop - activationTop;
        if (distance <= 0 && distance > nextDistance) {
          nextDistance = distance;
          nextPath = file.path;
        }
      }

      const programmaticScrollPath = programmaticScrollPathRef.current;
      if (programmaticScrollPath && nextPath !== programmaticScrollPath) {
        return;
      }

      if (programmaticScrollPath) {
        programmaticScrollPathRef.current = null;
        if (programmaticScrollTimerRef.current != null) {
          window.clearTimeout(programmaticScrollTimerRef.current);
          programmaticScrollTimerRef.current = null;
        }
      }

      if (nextPath) {
        setSelectedPath((current) => (current === nextPath ? current : nextPath));
      }
    },
    [showWhitespace, visibleFiles],
  );

  const toggleViewed = useCallback(
    (file: ChangedFile, isViewed: boolean) => {
      if (!state) {
        return;
      }

      setViewed((current) => {
        if (isViewed) {
          const next = { ...current };
          delete next[file.path];
          if (state.source.type === 'working-tree') {
            writeViewed(state.root, next);
          }
          return next;
        }

        const next = {
          ...current,
          [file.path]: file.fingerprint,
        };
        if (state.source.type === 'working-tree') {
          writeViewed(state.root, next);
        }
        return next;
      });

      setCollapsed((current) => {
        if (isViewed) {
          const next = new Set(current);
          next.delete(file.path);
          return next;
        }

        const next = new Set(current);
        next.add(file.path);
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion, state],
  );

  const createComment = useCallback((comment: Omit<ReviewComment, 'body' | 'id'>) => {
    const emptyExistingComment = reviewCommentsRef.current.find(
      (candidate) =>
        candidate.body.length === 0 && getCommentKey(candidate) === getCommentKey(comment),
    );
    if (emptyExistingComment) {
      setFocusCommentId(emptyExistingComment.id);
      setFocusCommentRequest((current) => current + 1);
      return;
    }

    const id = crypto.randomUUID();
    setFocusCommentId(id);
    setFocusCommentRequest((current) => current + 1);

    setReviewComments((current) => [
      ...current,
      {
        ...comment,
        body: '',
        id,
      },
    ]);
  }, []);

  const updateComment = useCallback((commentId: string, body: string) => {
    setReviewComments((current) =>
      current.map((comment) =>
        comment.id === commentId && !comment.isReadOnly ? { ...comment, body } : comment,
      ),
    );
  }, []);

  const deleteComment = useCallback((commentId: string) => {
    setFocusCommentId((current) => (current === commentId ? null : current));
    setReviewComments((current) => current.filter((comment) => comment.id !== commentId));
  }, []);

  const updateCodexReply = useCallback(
    (commentId: string, filePath: string, codexReply: NonNullable<ReviewComment['codexReply']>) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                codexReply,
              }
            : comment,
        ),
      );
      bumpItemVersion(filePath);
    },
    [bumpItemVersion],
  );

  const updateGitHubSubmit = useCallback(
    (commentId: string, githubSubmit: ReviewComment['githubSubmit']) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                githubSubmit,
              }
            : comment,
        ),
      );
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (comment) {
        bumpItemVersion(comment.filePath);
      }
    },
    [bumpItemVersion],
  );

  const askCodex = useCallback(
    (commentId: string) => {
      const currentState = stateRef.current;
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        !currentState ||
        !comment ||
        comment.body.trim().length === 0 ||
        comment.codexReply?.status === 'loading'
      ) {
        return;
      }

      const note = walkthroughNotes.get(comment.filePath);
      const request: ReviewAssistantRequest = {
        comment: {
          body: comment.body,
          filePath: comment.filePath,
          lineNumber: comment.lineNumber,
          sectionId: comment.sectionId,
          side: comment.side,
          ...getReviewCommentRangeProps(comment),
        },
        source: currentState.source,
        walkthroughNote: note
          ? {
              action: note.action,
              context: note.context,
              groupReason: note.groupReason,
              groupTitle: note.groupTitle,
              impact: note.impact,
              reason: note.reason,
            }
          : undefined,
      };

      updateCodexReply(comment.id, comment.filePath, { status: 'loading' });
      void window.codiff
        .askReviewAssistant(request)
        .then((result) => {
          updateCodexReply(
            comment.id,
            comment.filePath,
            result.status === 'ready'
              ? {
                  body: result.reply,
                  status: 'ready',
                }
              : {
                  error: result.reason,
                  status: 'error',
                },
          );
        })
        .catch((error: unknown) => {
          updateCodexReply(comment.id, comment.filePath, {
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        });
    },
    [updateCodexReply, walkthroughNotes],
  );

  const submitPullRequestComment = useCallback(
    (commentId: string) => {
      const currentState = stateRef.current;
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        currentState?.source.type !== 'pull-request' ||
        !comment ||
        comment.body.trim().length === 0 ||
        comment.githubSubmit?.status === 'submitting'
      ) {
        return;
      }

      updateGitHubSubmit(comment.id, { status: 'submitting' });
      void window.codiff
        .submitPullRequestComment({
          comment: {
            body: comment.body,
            filePath: comment.filePath,
            lineNumber: comment.lineNumber,
            side: comment.side,
            ...getReviewCommentRangeProps(comment),
          },
          source: currentState.source,
        })
        .then((submittedComment) => {
          setFocusCommentId((current) => (current === comment.id ? null : current));
          setReviewComments((current) =>
            current.map((candidate) =>
              candidate.id === comment.id
                ? {
                    author: submittedComment.author,
                    body: submittedComment.body,
                    filePath: submittedComment.filePath,
                    id: submittedComment.id,
                    isReadOnly: true,
                    lineNumber: submittedComment.lineNumber,
                    sectionId: comment.sectionId,
                    side: submittedComment.side,
                    ...getReviewCommentRangeProps(submittedComment),
                    submittedAt: submittedComment.submittedAt,
                    url: submittedComment.url,
                  }
                : candidate,
            ),
          );
          bumpItemVersion(comment.filePath);
        })
        .catch((error: unknown) => {
          updateGitHubSubmit(comment.id, {
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        });
    },
    [bumpItemVersion, updateGitHubSubmit],
  );

  const submitPullRequestReview = useCallback(
    (event: PullRequestReviewEvent) => {
      const currentState = stateRef.current;
      if (currentState?.source.type !== 'pull-request' || pullRequestReviewSubmitting) {
        return;
      }

      const pendingComments = reviewCommentsRef.current.filter(
        (comment) => !comment.isReadOnly && comment.body.trim(),
      );
      const pendingCommentIds = new Set(pendingComments.map((comment) => comment.id));
      setPullRequestReviewSubmitting(event);
      void window.codiff
        .submitPullRequestReview({
          comments: pendingComments.map((comment) => ({
            body: comment.body,
            filePath: comment.filePath,
            lineNumber: comment.lineNumber,
            side: comment.side,
            ...getReviewCommentRangeProps(comment),
          })),
          event,
          source: currentState.source,
        })
        .then(() => {
          setReviewComments((current) =>
            current.filter((comment) => !pendingCommentIds.has(comment.id)),
          );
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          setPullRequestReviewSubmitting(null);
        });
    },
    [pullRequestReviewSubmitting],
  );

  const installTerminalHelper = useCallback(() => {
    setTerminalHelperInstalling(true);
    window.codiff
      .installTerminalHelper()
      .then((status) => setTerminalHelperStatus(status))
      .catch(() => {
        setTerminalHelperStatus(defaultTerminalHelperStatus);
      })
      .finally(() => {
        setTerminalHelperInstalling(false);
      });
  }, []);

  if (loadError) {
    const showFirstRun =
      loadError.kind === 'not-a-repository' &&
      !launchOptions.repositoryPathProvided &&
      !terminalHelperStatus.installed;

    return (
      <main className="empty-state">
        <div className="empty-panel squircle">
          {showFirstRun ? (
            <FirstRunPanel
              installing={terminalHelperInstalling}
              onInstallTerminalHelper={installTerminalHelper}
            />
          ) : (
            <RepositoryLoadErrorPanel error={loadError} />
          )}
        </div>
      </main>
    );
  }

  if (!state) {
    return (
      <main className={`loading italic${launchOptions.walkthrough ? ' codex' : ' pulse'}`}>
        {launchOptions.walkthrough ? 'Waiting on Codex…' : 'Thinking…'}
      </main>
    );
  }

  const selectedOrSearchPath = activeDiffSearchMatch?.filePath ?? selectedPath;
  const visibleSelectedPath =
    selectedOrSearchPath && visibleFiles.some((file) => file.path === selectedOrSearchPath)
      ? selectedOrSearchPath
      : (visibleFiles[0]?.path ?? null);
  const hasDiffSearchQuery = diffSearchQuery.trim().length > 0;
  const isPullRequest = state.source.type === 'pull-request';
  const isSwitchingSource = pendingSource != null;

  return (
    <div className="app-shell">
      <RepositoryChangeBanner
        visible={localChangesDetected && (pendingSource ?? state.source).type === 'working-tree'}
      />
      <DiffSearchPanel
        activeIndex={effectiveActiveDiffSearchMatchIndex}
        focusRequest={diffSearchFocusRequest}
        matchCount={diffSearchMatches.length}
        onChange={updateDiffSearchQuery}
        onClose={closeDiffSearch}
        onNext={() => moveDiffSearchMatch(1)}
        onPrevious={() => moveDiffSearchMatch(-1)}
        query={diffSearchQuery}
        visible={diffSearchVisible}
      />
      {!isSwitchingSource ? (
        <div className="review-action-bar">
          <CopyCommentsButton
            comments={reviewComments}
            files={orderedFiles}
            showWhitespace={showWhitespace}
          />
          {isPullRequest ? (
            <PullRequestReviewButtons
              disabled={pullRequestReviewSubmitting != null}
              onSubmitReview={submitPullRequestReview}
              submittingEvent={pullRequestReviewSubmitting}
            />
          ) : null}
        </div>
      ) : null}
      <aside className="squircle sidebar">
        <div className="sidebar-header">
          <div className="sidebar-path-row">
            <div className="sidebar-path" title={state.root}>
              {compactPath(state.root)}
              {state.source.type !== 'working-tree' ? ` · ${getSourceLabel(state.source)}` : ''}
            </div>
          </div>
        </div>
        <Sidebar
          currentSource={pendingSource ?? state.source}
          files={visibleFiles}
          historyEntries={historyEntries}
          historyHasMore={historyHasMore}
          historyLoading={historyLoading}
          mode={sidebarMode}
          onActivatePath={activatePath}
          onLoadMoreHistory={loadMoreHistory}
          onModeChange={changeSidebarMode}
          onSearchQueryChange={
            sidebarMode === 'history' ? setHistorySearchQuery : setFileSearchQuery
          }
          onSelectPath={selectPath}
          onSelectSource={selectSource}
          pullRequestSource={historyPullRequestSource}
          searchQuery={sidebarMode === 'history' ? historySearchQuery : fileSearchQuery}
          selectedPath={visibleSelectedPath}
          showWhitespace={showWhitespace}
          walkthroughAvailable={walkthrough != null}
          walkthroughError={walkthroughError}
          walkthroughLoading={walkthroughLoading}
          walkthroughNotes={walkthroughNotes}
          walkthroughSummary={walkthrough?.summary ?? null}
          walkthroughUnread={walkthroughUnread}
        />
      </aside>
      <main className="review">
        {isSwitchingSource ? (
          <ReviewSourceLoading />
        ) : state.files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>
                {state.source.type === 'commit' ? 'No changes in commit' : 'No local changes'}
              </strong>
              <span>
                {state.source.type === 'commit' ? getShortRef(state.source.ref) : state.root}
              </span>
            </div>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>{hasDiffSearchQuery ? 'No matches in diffs' : 'No matching files'}</strong>
              <span>
                {diffSearchQuery ||
                  fileSearchQuery ||
                  (showWhitespace ? state.root : 'Whitespace-only changes hidden')}
              </span>
            </div>
          </div>
        ) : (
          <ReviewCodeView
            activeSearchMatch={activeDiffSearchMatch}
            collapsed={collapsed}
            comments={reviewComments}
            files={visibleFiles}
            focusCommentId={focusCommentId}
            focusCommentRequest={focusCommentRequest}
            forceExpandedPaths={diffSearchMatchPathSet}
            gitIdentity={gitIdentity}
            isPullRequest={isPullRequest}
            itemVersionByPath={itemVersionByPath}
            onAskCodex={askCodex}
            onCreateComment={createComment}
            onDeleteComment={deleteComment}
            onOpenFile={openFile}
            onSelectPathFromScroll={updateSelectedPathFromScroll}
            onSubmitComment={submitPullRequestComment}
            onToggleCollapsed={toggleCollapsed}
            onToggleViewed={toggleViewed}
            onUpdateComment={updateComment}
            scrollTarget={scrollTarget}
            searchQuery={diffSearchQuery}
            selectedPath={visibleSelectedPath}
            showWhitespace={showWhitespace}
            viewed={viewed}
            walkthroughNotes={
              sidebarMode === 'walkthrough' ? walkthroughNotes : emptyWalkthroughNotes
            }
          />
        )}
      </main>
    </div>
  );
}
