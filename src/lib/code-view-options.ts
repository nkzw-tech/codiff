import { registerCustomTheme, type FileOptions } from '@pierre/diffs';
import dunkelTheme from '../themes/dunkel.json' with { type: 'json' };
import lichtTheme from '../themes/licht.json' with { type: 'json' };
import type { DiffSection, GitFileStatus } from '../types.ts';

registerCustomTheme('Licht', async () => lichtTheme as never);
registerCustomTheme('Dunkel', async () => dunkelTheme as never);

export const statusLabel: Record<GitFileStatus, string> = {
  added: 'Added',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  untracked: 'Untracked',
};

export const sectionLabel: Record<DiffSection['kind'], string> = {
  commit: 'Commit',
  'pull-request': 'PR',
  staged: 'Staged',
  unstaged: 'Unstaged',
};

// 11px needed to account for the box shadow around individual diffs
export const DEFAULT_PADDING = 11;

export const codeViewLayout = {
  // 2px is used to account for a 10px gap with the 1px box shadows
  gap: 12,
  paddingBottom: DEFAULT_PADDING,
  paddingTop: DEFAULT_PADDING,
};

export const codeViewItemMetrics = {
  diffHeaderHeight: 54,
};

export const diffContextExpansionLineCount = 100;
export const diffCollapsedContextThreshold = 12;

export const workerHighlighterOptions = {
  maxLineDiffLength: 2000,
  theme: {
    dark: 'Dunkel',
    light: 'Licht',
  },
  tokenizeMaxLineLength: 20_000,
  useTokenTransformer: false,
};

export const markdownCodeBlockOptions = {
  disableFileHeader: true,
  disableLineNumbers: true,
  enableGutterUtility: false,
  lineHoverHighlight: 'disabled',
  overflow: 'wrap',
  theme: {
    dark: 'Dunkel',
    light: 'Licht',
  },
  themeType: 'system',
  tokenizeMaxLength: 100_000,
  tokenizeMaxLineLength: 20_000,
  unsafeCSS: `
    :host {
      --diffs-font-family: var(--font-mono);
      --diffs-font-size: 13px;
      --diffs-line-height: 20px;
      --diffs-light-bg: transparent;
      --diffs-dark-bg: transparent;
      --diffs-bg: transparent;
      --diffs-bg-context: transparent;
      --diffs-bg-context-gutter: transparent;
      --diffs-bg-buffer: transparent;
      --diffs-bg-separator: transparent;
      --diffs-bg-hover-override: transparent;
    }

    [data-file] {
      background: transparent;
      border: 0;
      box-shadow: none;
    }

    pre,
    code,
    [data-file] [data-code],
    [data-file] [data-content],
    [data-file] [data-gutter] {
      background: transparent;
      background-color: transparent;
      min-width: 0;
    }

    [data-file] [data-line],
    [data-file] [data-column-number],
    [data-file] [data-gutter-buffer],
    [data-file] [data-line-annotation] {
      --diffs-computed-decoration-bg: transparent;
      --diffs-computed-diff-line-bg: transparent;
      --diffs-computed-selected-line-bg: transparent;
      --diffs-computed-hovered-line-bg: transparent;
      --diffs-line-bg: transparent;
      background: transparent;
      background-color: transparent;
    }

    [data-file] [data-line][data-hovered],
    [data-file] [data-column-number][data-hovered] {
      --diffs-line-bg: transparent;
      background-color: transparent;
    }

    [data-file] [data-gutter-utility-slot],
    [data-file] [data-utility-button] {
      display: none;
      pointer-events: none;
    }

    [data-file] [data-code] {
      max-height: 420px;
      max-width: 100%;
      overflow-x: hidden;
    }

    [data-overflow="wrap"] [data-line] {
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      word-break: break-word;
    }

    [data-code]::-webkit-scrollbar-track {
      margin-left: 0;
      margin-right: 0;
    }
  `,
  useTokenTransformer: false,
} satisfies FileOptions<never>;

export const maxWorkerThreads = 3;

export const codeViewUnsafeCSS = `
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

  /* Commit details render through CodeView's file layout; hide the file UI around the panel. */
  :host(.codiff-commit-details-item) {
    --diffs-scrollbar-gutter-override: 0px;
    background: transparent;
    border: 0;
    box-shadow: none;
  }

  :host(.codiff-commit-details-item) [data-diffs-header="custom"][data-sticky] {
    display: none;
  }

  :host(.codiff-commit-details-item) [data-file] {
    background: transparent;
    border: 0;
    box-shadow: none;
  }

  :host(.codiff-commit-details-item) [data-file] [data-code] {
    overflow: visible;
    padding-bottom: 0;
    padding-top: 0;
    scrollbar-width: none;
  }

  :host(.codiff-commit-details-item) [data-file] [data-code]::-webkit-scrollbar {
    display: none;
  }

  :host(.codiff-commit-details-item) [data-file] [data-line],
  :host(.codiff-commit-details-item) [data-file] [data-column-number],
  :host(.codiff-commit-details-item) [data-file] [data-gutter-buffer],
  :host(.codiff-commit-details-item) [data-file] [data-gutter-gap] {
    display: none;
  }

  :host(.codiff-commit-details-item) [data-file] [data-code],
  :host(.codiff-commit-details-item) [data-file] [data-content] {
    display: block;
  }

  :host(.codiff-commit-details-item) [data-file] [data-line-annotation] {
    background: transparent;
    grid-column: 1 / -1;
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

  :host(.codiff-markdown-preview-item) [data-file] [data-code] {
    grid-column: 1 / -1;
  }

  :host(.codiff-markdown-preview-item) [data-file] [data-line="1"][data-line-index="0"][data-line-type="context"],
  :host(.codiff-markdown-preview-item) [data-file] [data-column-number="1"][data-line-index="0"][data-line-type="context"],
  :host(.codiff-markdown-preview-item) [data-gutter] > [data-gutter-utility-slot] {
    display: none;
    pointer-events: none;
  }

  :host(.codiff-image-preview-item) [data-file] {
    --diffs-code-grid: 1fr;
  }

  :host(.codiff-image-preview-item) [data-file] [data-code] {
    grid-column: 1 / -1;
    padding-block: 0;
  }

  :host(.codiff-image-preview-item) [data-file] [data-content] {
    grid-column: 1;
  }

  :host(.codiff-image-preview-item) [data-file] [data-gutter],
  :host(.codiff-image-preview-item) [data-file] [data-line="1"][data-line-index="0"][data-line-type="context"] {
    display: none;
    pointer-events: none;
  }

  :host(.codiff-loadable-summary-item) [data-file] [data-line],
  :host(.codiff-loadable-summary-item) [data-file] [data-column-number] {
    cursor: pointer;
  }

  :host(.codiff-loading-summary-item) [data-file] [data-line],
  :host(.codiff-loading-summary-item) [data-file] [data-column-number] {
    cursor: progress;
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
