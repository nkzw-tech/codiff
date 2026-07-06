/**
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, expect, test, vi } from 'vite-plus/test';
import App from '../App.tsx';
import { createDefaultConfig, defaultSettings } from '../config/defaults.ts';
import {
  consumeReloadSelection,
  getReloadSelectionPath,
  writeReloadSelection,
} from '../lib/reload-selection.ts';
import type {
  ChangedFile,
  CommitMetadata,
  NarrativeWalkthrough,
  PlanReview,
  RepositoryState,
  ReviewSource,
} from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  ResizeObserver?: typeof ResizeObserver;
  Worker?: typeof Worker;
};
reactActEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollBy ??= function scrollBy() {};
HTMLElement.prototype.scrollTo ??= function scrollTo() {};
class StubWorker extends EventTarget {
  constructor(_scriptURL: string | URL, _options?: WorkerOptions) {
    super();
  }
  onerror = null;
  onmessage = null;
  postMessage() {}
  terminate() {}
}
reactActEnvironment.Worker ??= StubWorker as unknown as typeof Worker;

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: createMemoryStorage(),
});
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: createMemoryStorage(),
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.style.removeProperty('--font-diff-line-height');
  document.documentElement.style.removeProperty('--font-diff-mono');
  document.documentElement.style.removeProperty('--font-diff-size');
});

const repositoryState = {
  branch: 'main',
  files: [],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;

const createCodiffMock = (overrides: Partial<Window['codiff']> = {}): Window['codiff'] => ({
  askReviewAssistant: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  completePlan: vi.fn(async () => {}),
  createWalkthroughCommit: vi.fn(async () => ({
    hash: '0000000000000000000000000000000000000000',
    status: 'committed' as const,
  })),
  decreaseCodeFontSize: vi.fn(async () => {}),
  getAgentSkillStatus: vi.fn(async () => ({
    installed: true,
    path: '/Users/reviewer/.codex/skills/codiff',
  })),
  getConfig: vi.fn(async () => createDefaultConfig()),
  getDiffImageContent: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  getDiffSectionContent: vi.fn(async () => {
    throw new Error('Unexpected diff section load.');
  }),
  getFeatureFlags: vi.fn(async () => ({
    planSharing: false,
    walkthroughSharing: false,
  })),
  getGitIdentity: vi.fn(async () => ({
    email: 'reviewer@example.com',
    name: 'Reviewer',
  })),
  getLaunchOptions: vi.fn(async () => ({
    repositoryPathProvided: true,
    walkthrough: false,
  })),
  getMarkdownDocument: vi.fn(async ({ kind, path }) => ({
    content: '# Plan\n',
    id: `${kind}:${path}`,
    kind,
    path,
    version: 'version',
  })),
  getNarrativeWalkthrough: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  getPlanReview: vi.fn(async () => null),
  getPreferences: vi.fn(async () => ({
    agentBackend: 'codex' as const,
    claudeModel: defaultSettings.claudeModel,
    codeFontFamily: defaultSettings.codeFontFamily,
    codeFontSize: defaultSettings.codeFontSize,
    copyCommentsOnClose: true,
    diffStyle: 'split' as const,
    editorCommand: '',
    lastRepositoryPath: '/repo',
    openAIModel: defaultSettings.openAIModel,
    opencodeModel: defaultSettings.opencodeModel,
    piModel: defaultSettings.piModel,
    reviewCommentsPrefix: defaultSettings.reviewCommentsPrefix,
    showOutdated: false,
    showWhitespace: false,
    theme: 'system' as const,
    walkthroughPrompt: defaultSettings.walkthroughPrompt,
    wordWrap: false,
  })),
  getRepositoryHistory: vi.fn(async () => ({
    entries: [],
    root: '/repo',
  })),
  getRepositoryState: vi.fn(async () => repositoryState),
  getTerminalHelperStatus: vi.fn(async () => ({
    command: 'codiff',
    installed: true,
    path: '/usr/local/bin/codiff',
  })),
  increaseCodeFontSize: vi.fn(async () => {}),
  installAgentSkill: vi.fn(async () => ({
    installed: true,
    path: '/Users/reviewer/.codex/skills/codiff',
  })),
  installTerminalHelper: vi.fn(async () => ({
    command: 'codiff',
    installed: true,
    path: '/usr/local/bin/codiff',
  })),
  isWindowFullScreen: vi.fn(async () => false),
  markPlanReady: vi.fn(async () => {}),
  onConfigChanged: vi.fn(() => () => {}),
  onCopyPendingCommentsRequest: vi.fn(() => () => {}),
  onFindInDiffs: vi.fn(() => () => {}),
  onMarkdownDocumentChanged: vi.fn(() => () => {}),
  onPlanCloseRequested: vi.fn(() => () => {}),
  onRefreshRequest: vi.fn(() => () => {}),
  onRepositoryChanged: vi.fn(() => () => {}),
  onWindowFullScreenChanged: vi.fn(() => () => {}),
  openConfigFile: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
  resetCodeFontSize: vi.fn(async () => {}),
  saveMarkdownDocument: vi.fn(async (request) => ({
    document: {
      content: request.content,
      id: `${request.kind}:${request.path}`,
      kind: request.kind,
      path: request.path,
      version: 'next-version',
    },
    status: 'saved' as const,
  })),
  savePlanReview: vi.fn(async (review) => review),
  setDiffStyle: vi.fn(async () => {}),
  setShowOutdated: vi.fn(async () => {}),
  setWordWrap: vi.fn(async () => {}),
  sharePlan: vi.fn(async () => ({
    status: 'uploaded' as const,
    url: 'https://codiff.dev/p/test',
  })),
  shareWalkthrough: vi.fn(async () => ({
    status: 'uploaded' as const,
    url: 'https://codiff.dev/w/test',
  })),
  showInFolder: vi.fn(async () => {}),
  submitPullRequestComment: vi.fn(async () => {
    throw new Error('Unexpected pull request comment submit.');
  }),
  submitPullRequestReview: vi.fn(async () => {}),
  updateWalkthroughCommitMessage: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  ...overrides,
});

const dispatchModK = () => {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: !isMac, key: 'k', metaKey: isMac }));
};

const renderAppForOpenFileShortcut = async (file: ChangedFile) => {
  const openFile = vi.fn(async () => {});

  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [file],
    })),
    openFile,
  });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<App />);
  });

  await waitFor(() => {
    expect(container.querySelector('.loading')).toBeNull();
    expect(container.querySelector('.codiff-file-header')).not.toBeNull();
  });

  return {
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
    openFile,
  };
};

test('code font preferences update root CSS variables', async () => {
  const nextConfig = createDefaultConfig();
  nextConfig.settings.codeFontFamily = 'JetBrains Mono';
  nextConfig.settings.codeFontSize = 14;
  window.codiff = createCodiffMock({
    getConfig: vi.fn(async () => nextConfig),
  });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<App />);
  });

  await waitFor(() => {
    expect(document.documentElement.style.getPropertyValue('--font-diff-mono')).toBe(
      '"JetBrains Mono", monospace',
    );
    expect(document.documentElement.style.getPropertyValue('--font-diff-size')).toBe('14px');
    expect(document.documentElement.style.getPropertyValue('--font-diff-line-height')).toBe('22px');
  });

  await act(async () => root.unmount());
  container.remove();
});

test('empty code font family removes the root CSS variable', async () => {
  document.documentElement.style.setProperty('--font-diff-mono', 'stale');
  window.codiff = createCodiffMock();

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<App />);
  });

  await waitFor(() => {
    expect(document.documentElement.style.getPropertyValue('--font-diff-mono')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--font-diff-size')).toBe('13px');
    expect(document.documentElement.style.getPropertyValue('--font-diff-line-height')).toBe('20px');
  });

  await act(async () => root.unmount());
  container.remove();
});

test('stale persisted collapsed sidebar state does not hide the sidebar on launch', async () => {
  window.localStorage.setItem('codiff:sidebar-collapsed', 'true');
  window.codiff = createCodiffMock();

  const app = await renderReact(<App />);

  await waitFor(() => {
    expect(app.container.querySelector('.app-shell')?.classList.contains('sidebar-collapsed')).toBe(
      false,
    );
    expect(app.container.querySelector('.sidebar')).not.toBeNull();
  });

  await app.cleanup();
});

test('empty repository state fills the review pane for centered layout', async () => {
  window.codiff = createCodiffMock();

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<App />);
  });

  await waitFor(() => {
    const emptyState = container.querySelector<HTMLElement>('.review > .empty-state');
    expect(emptyState?.textContent).toContain('No local changes');
  });
  const css = readFileSync(resolve('core/App.css'), 'utf8');
  const emptyStateRule = css.match(/\.review > \.empty-state \{([^}]*)\}/)?.[1];
  expect(emptyStateRule).toContain('flex: 1;');
  expect(emptyStateRule).toContain('min-width: 0;');
  expect(emptyStateRule).toContain('width: 100%;');

  await act(async () => root.unmount());
  container.remove();
});

test('showWhitespace config changes reload the current repository state', async () => {
  let configListener: ((config: ReturnType<typeof createDefaultConfig>) => void) | null = null;
  const nextConfig = createDefaultConfig();
  nextConfig.settings.showWhitespace = true;
  const initialState = {
    ...repositoryState,
    files: [createChangedFile('src/initial.ts')],
  };
  const reloadedState = {
    ...repositoryState,
    files: [createChangedFile('src/reloaded.ts')],
  };
  const getRepositoryState = vi
    .fn<Window['codiff']['getRepositoryState']>()
    .mockResolvedValueOnce(initialState)
    .mockResolvedValueOnce(reloadedState);
  window.codiff = createCodiffMock({
    getRepositoryState,
    onConfigChanged: vi.fn((callback) => {
      configListener = callback;
      return () => {};
    }),
  });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<App />);
  });

  await waitFor(() => {
    expect(container.textContent).toContain('src/initial.ts');
  });

  await act(async () => {
    configListener?.(nextConfig);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  await waitFor(() => {
    expect(container.textContent).toContain('src/reloaded.ts');
  });
  expect(getRepositoryState).toHaveBeenLastCalledWith({ type: 'working-tree' });

  await act(async () => root.unmount());
  container.remove();
});

test('sidebar commit button toggles back to tree when commit view is open', async () => {
  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [createChangedFile('src/change.ts')],
    })),
  });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<App />);
  });

  await waitFor(() => {
    expect(container.querySelector('.sidebar-commit-button')?.textContent).toBe('Commit');
  });

  await act(async () => {
    container.querySelector<HTMLButtonElement>('.sidebar-commit-button')?.click();
  });

  await waitFor(() => {
    expect(container.querySelector('.wt-commit')).not.toBeNull();
    expect(container.querySelector('.sidebar-commit-button')?.textContent).toBe('Tree');
  });

  await act(async () => {
    container.querySelector<HTMLButtonElement>('.sidebar-commit-button')?.click();
  });

  await waitFor(() => {
    expect(container.querySelector('.wt-commit')).toBeNull();
    expect(container.querySelector('.sidebar-commit-button')?.textContent).toBe('Commit');
  });

  await act(async () => root.unmount());
  container.remove();
});

test('repository reload restores the selected file when it still exists', async () => {
  const firstFile = createChangedFile('src/first.ts');
  const secondFile = createChangedFile('src/second.ts');
  const nextState = {
    ...repositoryState,
    files: [firstFile, secondFile],
  } satisfies RepositoryState;

  writeReloadSelection(nextState, secondFile.path);
  const openFile = vi.fn(async () => {});

  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => nextState),
    openFile,
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
      expect(container.querySelector('.codiff-file-header')).not.toBeNull();
    });
    await act(async () => {
      dispatchModK();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(openFile).toHaveBeenCalledWith(secondFile.path);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
    window.sessionStorage.clear();
  }
});

test('repository reload restores the selected file from the previous source', async () => {
  const firstFile = createChangedFile('src/first.ts');
  const secondFile = createChangedFile('src/second.ts');
  const source = { ref: 'abc1234', type: 'commit' } satisfies ReviewSource;
  const nextState = {
    ...repositoryState,
    files: [firstFile, secondFile],
    source,
  } satisfies RepositoryState;
  const getRepositoryState = vi.fn(async (requestedSource?: ReviewSource) =>
    requestedSource?.type === 'commit' ? nextState : repositoryState,
  );

  writeReloadSelection(nextState, secondFile.path);
  const openFile = vi.fn(async () => {});

  window.codiff = createCodiffMock({
    getRepositoryState,
    openFile,
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
      expect(container.querySelector('.codiff-file-header')).not.toBeNull();
    });
    await act(async () => {
      dispatchModK();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(openFile).toHaveBeenCalledWith(secondFile.path);
    expect(getRepositoryState).toHaveBeenCalledWith(source);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('repository reload preserves a branch diff source even without a selected file', async () => {
  const source = {
    baseRef: 'base123',
    headRef: 'head123',
    ref: 'main',
    type: 'branch-diff',
  } satisfies ReviewSource;
  const nextState = {
    ...repositoryState,
    files: [],
    source,
  } satisfies RepositoryState;
  const getRepositoryState = vi.fn(async (requestedSource?: ReviewSource) =>
    requestedSource?.type === 'branch-diff' ? nextState : repositoryState,
  );

  writeReloadSelection(nextState, null);

  window.codiff = createCodiffMock({
    getRepositoryState,
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
    });
    expect(getRepositoryState).toHaveBeenCalledWith(source);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('branch history keeps branch diff available after selecting uncommitted changes', async () => {
  const branchSource = {
    baseRef: 'base123',
    headRef: 'head123',
    ref: 'main',
    type: 'branch-diff',
  } satisfies ReviewSource;
  const branchState = {
    ...repositoryState,
    branch: 'fork',
    source: branchSource,
  } satisfies RepositoryState;
  const workingTreeState = {
    ...repositoryState,
    branch: 'fork',
    source: { type: 'working-tree' },
  } satisfies RepositoryState;
  const getRepositoryState = vi.fn(async (requestedSource?: ReviewSource) =>
    requestedSource?.type === 'working-tree' ? workingTreeState : branchState,
  );

  window.codiff = createCodiffMock({
    getRepositoryHistory: vi.fn(async () => ({
      entries: [
        {
          author: 'Reviewer',
          committedAt: Date.now(),
          parents: [],
          ref: '99e7b27',
          subject: 'Add branch diff review mode',
        },
      ],
      root: '/repo',
    })),
    getRepositoryState,
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  const findButton = (label: string) =>
    Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(label),
    );

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
      expect(findButton('Branch diff')).toBeTruthy();
    });

    await act(async () => {
      findButton('Uncommitted')?.click();
    });

    await waitFor(() => {
      expect(getRepositoryState).toHaveBeenCalledWith({ type: 'working-tree' });
      expect(findButton('Branch diff')).toBeTruthy();
    });

    await act(async () => {
      findButton('Branch diff')?.click();
    });

    await waitFor(() => {
      expect(getRepositoryState).toHaveBeenCalledWith(branchSource);
    });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('repository reload restores branch diff scope after selecting uncommitted changes', async () => {
  const branchSource = {
    baseRef: 'base123',
    headRef: 'head123',
    ref: 'main',
    type: 'branch-diff',
  } satisfies ReviewSource;
  const workingTreeState = {
    ...repositoryState,
    branch: 'fork',
    source: { type: 'working-tree' },
  } satisfies RepositoryState;
  const getRepositoryHistory = vi.fn(async () => ({
    entries: [
      {
        author: 'Reviewer',
        committedAt: Date.now(),
        parents: [],
        ref: '99e7b27',
        subject: 'Add branch diff review mode',
      },
    ],
    root: '/repo',
  }));
  const getRepositoryState = vi.fn(async () => workingTreeState);

  writeReloadSelection(workingTreeState, null, branchSource);

  window.codiff = createCodiffMock({
    getRepositoryHistory,
    getRepositoryState,
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  const findButton = (label: string) =>
    Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(label),
    );

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
      expect(findButton('Branch diff')).toBeTruthy();
    });
    expect(getRepositoryState).toHaveBeenCalledWith({ type: 'working-tree' });
    expect(getRepositoryHistory).toHaveBeenCalledWith(expect.any(Number), branchSource);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('repository reload does not let stale selection override launch source', async () => {
  const launchSource = { ref: 'main', type: 'branch' } satisfies ReviewSource;
  const staleState = {
    ...repositoryState,
    source: { type: 'working-tree' },
  } satisfies RepositoryState;
  const branchState = {
    ...repositoryState,
    source: launchSource,
  } satisfies RepositoryState;
  const getRepositoryState = vi.fn(async (requestedSource?: ReviewSource) =>
    requestedSource?.type === 'working-tree' ? staleState : branchState,
  );

  writeReloadSelection(staleState, null);

  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      source: launchSource,
      walkthrough: false,
    })),
    getRepositoryState,
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
    });
    expect(getRepositoryState).toHaveBeenCalledWith(undefined);
    expect(getRepositoryState).not.toHaveBeenCalledWith(staleState.source);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('repository reload colors only git status glyphs for files changed after reload', async () => {
  const unchangedFile = createChangedFile('src/unchanged.ts', { fingerprint: 'same' });
  const changedFileBeforeReload = createChangedFile('src/changed.ts', { fingerprint: 'before' });
  const changedFileAfterReload = createChangedFile('src/changed.ts', { fingerprint: 'after' });
  const previousState = {
    ...repositoryState,
    files: [unchangedFile, changedFileBeforeReload],
  } satisfies RepositoryState;
  const nextState = {
    ...repositoryState,
    files: [unchangedFile, changedFileAfterReload],
  } satisfies RepositoryState;

  writeReloadSelection(previousState, changedFileBeforeReload.path);

  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => nextState),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      const shadowRoot = container.querySelector('file-tree-container')?.shadowRoot;
      const styleText =
        shadowRoot?.querySelector('style[data-codiff-reload-delta-git-status]')?.textContent ?? '';
      expect(styleText).toContain('[data-item-path="src/changed.ts"][data-item-git-status]');
      expect(styleText).not.toContain('[data-item-path="src/unchanged.ts"][data-item-git-status]');
      expect(styleText).toContain("> [data-item-section='git']");
      expect(
        shadowRoot?.querySelector(
          '[data-item-path="src/changed.ts"][data-item-git-status] > [data-item-section="git"]',
        ),
      ).toBeTruthy();
      expect(
        shadowRoot?.querySelector(
          '[data-item-path="src/unchanged.ts"][data-item-git-status] > [data-item-section="git"]',
        ),
      ).toBeTruthy();
    });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('tree sidebar subtly mutes files currently marked viewed', async () => {
  const viewedFile = createChangedFile('src/viewed.ts', { fingerprint: 'viewed-current' });
  const staleViewedFile = createChangedFile('src/stale.ts', { fingerprint: 'stale-current' });
  const nextState = {
    ...repositoryState,
    files: [viewedFile, staleViewedFile],
  } satisfies RepositoryState;

  window.localStorage.setItem(
    'codiff:viewed:/repo',
    JSON.stringify({
      [staleViewedFile.path]: 'stale-previous',
      [viewedFile.path]: viewedFile.fingerprint,
    }),
  );
  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => nextState),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      const shadowRoot = container.querySelector('file-tree-container')?.shadowRoot;
      const styleText =
        shadowRoot?.querySelector('style[data-codiff-viewed-rows]')?.textContent ?? '';
      expect(styleText).toContain('[data-item-path="src/viewed.ts"]');
      expect(styleText).not.toContain('[data-item-path="src/stale.ts"]');
      expect(styleText).not.toContain('color-mix(in srgb, var(--viewed)');
      expect(styleText).toContain(
        "[data-item-path=\"src/viewed.ts\"] > [data-item-section='icon'] > :where(:not([data-icon-name='file-tree-icon-chevron']))",
      );
      expect(styleText).toContain("> [data-item-section='content']");
      expect(styleText).toContain('color: var(--muted)');
    });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('before unload saves the current source and selected file for any reload trigger', async () => {
  const changedFile = createChangedFile('src/app.ts');
  const source = { ref: 'abc1234', type: 'commit' } satisfies ReviewSource;
  const nextState = {
    ...repositoryState,
    files: [changedFile],
    source,
  } satisfies RepositoryState;

  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => nextState),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
    });

    window.dispatchEvent(new Event('beforeunload'));

    const selection = consumeReloadSelection();
    expect(selection?.source).toEqual(source);
    expect(getReloadSelectionPath(selection, nextState)).toBe(changedFile.path);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('Mod+K opens the selected file in the editor', async () => {
  const changedFile = createChangedFile('src/app.ts');
  const app = await renderAppForOpenFileShortcut(changedFile);

  try {
    await act(async () => {
      dispatchModK();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(app.openFile).toHaveBeenCalledWith(changedFile.path);
  } finally {
    await app.cleanup();
  }
});

test('Mod+K does not open deleted files', async () => {
  const deletedFile = {
    ...createChangedFile('src/removed.ts'),
    status: 'deleted',
  } satisfies ChangedFile;
  const app = await renderAppForOpenFileShortcut(deletedFile);

  try {
    await act(async () => {
      dispatchModK();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(app.openFile).not.toHaveBeenCalled();
  } finally {
    await app.cleanup();
  }
});

test('commit details render inline in the diff view', async () => {
  const changedFile = createChangedFile('src/app.ts');
  const source = { ref: 'abc1234', type: 'commit' } satisfies ReviewSource;
  const writeClipboardText = vi.fn(async () => undefined);
  const commitMetadata = {
    author: {
      date: '2026-01-01T12:00:00Z',
      email: 'author@example.com',
      name: 'Author',
    },
    body: 'Detailed commit body.',
    committer: {
      date: '2026-01-01T13:00:00Z',
      email: 'committer@example.com',
      name: 'Committer',
    },
    files: [
      {
        additions: 1,
        binary: false,
        deletions: 1,
        path: 'src/app.ts',
        status: 'modified' as const,
      },
    ],
    parents: ['parent-sha'],
    ref: 'abc1234',
    refs: ['main'],
    shortRef: 'abc1234',
    signature: {
      key: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789',
      signer: 'signer@example.test',
      status: 'G',
    },
    stats: {
      additions: 1,
      binaryFiles: 0,
      deletions: 1,
      files: 1,
      renamedFiles: 0,
    },
    subject: 'Commit subject',
    trailers: [
      {
        key: 'Co-authored-by',
        value: 'Second Author <second@example.com>',
      },
    ],
  } satisfies CommitMetadata;

  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      commitMetadata,
      files: [changedFile],
      source,
    })),
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: writeClipboardText,
    },
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
      expect(container.querySelector('.commit-details-panel')).not.toBeNull();
    });

    await waitFor(() => {
      expect(container.querySelector('.commit-details-panel')?.textContent).toContain(
        'Detailed commit body.',
      );
      expect(container.querySelector('.commit-details-panel')?.textContent).toContain(
        'Co-authored-by',
      );
    });

    const signature = container.querySelector<HTMLElement>('.commit-details-signature');
    if (!signature) {
      throw new Error('Expected commit signature.');
    }
    expect(signature.textContent).toBe(
      'Verified signature by signer@example.test (SHA256:abcd...6789)',
    );
    expect(signature.textContent).not.toContain(commitMetadata.signature.key);
    expect(signature.getAttribute('title')).toBe(commitMetadata.signature.key);

    const fileLineCount = container.querySelector<HTMLElement>('.commit-details-file-line-count');
    if (!fileLineCount) {
      throw new Error('Expected commit details file line count.');
    }
    expect(fileLineCount.querySelector('.codiff-line-count-added')?.textContent).toBe('+1');
    expect(fileLineCount.querySelector('.codiff-line-count-deleted')?.textContent).toBe('-1');

    const copyButton = container.querySelector<HTMLButtonElement>('.commit-details-copy');
    if (!copyButton) {
      throw new Error('Expected commit details copy button.');
    }

    await act(async () => {
      copyButton.click();
    });

    expect(writeClipboardText).toHaveBeenCalledWith(commitMetadata.ref);
    expect(copyButton.getAttribute('aria-label')).toBe('Commit hash copied');
    expect(copyButton.textContent).toContain(commitMetadata.shortRef);
    expect(copyButton.textContent).not.toContain('Copied');
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('pull request descriptions render as provider-aware Markdown source context', async () => {
  const changedFile = createChangedFile('src/app.ts');
  const cases: ReadonlyArray<{
    label: string;
    source: Extract<ReviewSource, { type: 'pull-request' }>;
  }> = [
    {
      label: 'PR description',
      source: {
        author: {
          avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
          login: 'octocat',
          url: 'https://github.com/octocat',
        },
        description: '## Intent\n\nShip **review** context.',
        number: 12,
        provider: 'github',
        type: 'pull-request',
        url: 'https://github.com/nkzw-tech/codiff/pull/12',
      },
    },
    {
      label: 'MR description',
      source: {
        description: '## Intent\n\nShip **review** context.',
        number: 13,
        provider: 'gitlab',
        type: 'pull-request',
        url: 'https://gitlab.example.com/group/project/-/merge_requests/13',
      },
    },
    {
      label: 'Description',
      source: {
        description: '## Intent\n\nShip **review** context.',
        number: 14,
        type: 'pull-request',
        url: 'https://example.com/reviews/14',
      },
    },
  ];

  for (const { label, source } of cases) {
    window.codiff = createCodiffMock({
      getRepositoryState: vi.fn(async () => ({
        ...repositoryState,
        files: [changedFile],
        source,
      })),
    });

    const app = await renderReact(<App />);

    try {
      await waitFor(() => {
        expect(app.container.querySelector('.codiff-source-description-header')).not.toBeNull();
      });
      const header = app.container.querySelector<HTMLElement>('.codiff-source-description-header');
      const body = app.container.querySelector<HTMLElement>('.source-description-markdown');
      expect(body?.textContent).toContain('Intent');
      expect(body?.textContent).toContain('Ship review context.');
      expect(header?.querySelector('.codiff-file-path')?.textContent).toBe(label);
      expect(header?.querySelector('.source-description-title')).toBeNull();
      if (source.author) {
        expect(header?.querySelector('.source-description-author')).toBeNull();
        expect(
          app.container.querySelector('.source-description-author-header')?.textContent,
        ).toContain(source.author.name ?? `@${source.author.login}`);
      } else {
        expect(header?.querySelector('.source-description-author')).toBeNull();
      }
      const toggle = header?.querySelector<HTMLButtonElement>('button.codiff-header-toggle');
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(toggle?.type).toBe('button');
    } finally {
      await app.cleanup();
    }
  }
});

test('pull request description collapse button toggles the markdown body', async () => {
  const source = {
    description: '## Intent\n\nShip **review** context.',
    number: 12,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/12',
  } satisfies ReviewSource;

  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [createChangedFile('src/app.ts')],
      source,
    })),
  });

  const app = await renderReact(<App />);

  try {
    await waitFor(() => {
      expect(app.container.querySelector('.source-description-markdown')).not.toBeNull();
    });

    let toggle = app.container.querySelector<HTMLButtonElement>('button.codiff-header-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(app.container.querySelector('.source-description-markdown')?.textContent).toContain(
      'Ship review context.',
    );

    await act(async () => {
      toggle?.click();
    });

    await waitFor(() => {
      toggle = app.container.querySelector<HTMLButtonElement>('button.codiff-header-toggle');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(app.container.querySelector('.source-description-markdown')).toBeNull();
    });

    await act(async () => {
      toggle?.click();
    });

    await waitFor(() => {
      expect(
        app.container
          .querySelector<HTMLButtonElement>('button.codiff-header-toggle')
          ?.getAttribute('aria-expanded'),
      ).toBe('true');
      expect(app.container.querySelector('.source-description-markdown')?.textContent).toContain(
        'Ship review context.',
      );
    });
  } finally {
    await app.cleanup();
  }
});

test('missing pull request descriptions do not render placeholder source context', async () => {
  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [createChangedFile('src/app.ts')],
      source: {
        description: '   ',
        number: 12,
        provider: 'github',
        type: 'pull-request',
        url: 'https://github.com/nkzw-tech/codiff/pull/12',
      } satisfies ReviewSource,
    })),
  });

  const app = await renderReact(<App />);

  try {
    await waitFor(() => {
      expect(app.container.querySelector('.codiff-file-header')).not.toBeNull();
    });
    expect(app.container.querySelector('.codiff-source-description-header')).toBeNull();
    expect(app.container.textContent).not.toContain('PR description');
  } finally {
    await app.cleanup();
  }
});

test('title-only pull request source context renders as a collapsed static header', async () => {
  const cases: ReadonlyArray<Extract<ReviewSource, { type: 'pull-request' }>> = [
    {
      description: '   ',
      number: 12,
      provider: 'github',
      title: 'Title without a body',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    },
    {
      number: 13,
      provider: 'gitlab',
      title: 'Merge request title only',
      type: 'pull-request',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/13',
    },
  ];

  for (const source of cases) {
    window.codiff = createCodiffMock({
      getRepositoryState: vi.fn(async () => ({
        ...repositoryState,
        files: [createChangedFile('src/app.ts')],
        source,
      })),
    });

    const app = await renderReact(<App />);

    try {
      await waitFor(() => {
        expect(app.container.querySelector('.codiff-source-description-header')).not.toBeNull();
      });
      const header = app.container.querySelector<HTMLElement>('.codiff-source-description-header');
      expect(header?.classList.contains('collapsed')).toBe(true);
      expect(header?.querySelector('.source-description-title')?.textContent).toBe(source.title);
      expect(header?.querySelector('.codiff-header-toggle-static')).not.toBeNull();
      expect(header?.querySelector('button.codiff-header-toggle')).toBeNull();
      expect(header?.querySelector('.codiff-chevron-box')).toBeNull();
      expect(app.container.querySelector('.source-description-markdown')).toBeNull();
    } finally {
      await app.cleanup();
    }
  }
});

test('narrative walkthrough stops show pull request descriptions once', async () => {
  const changedFile = createChangedFile('src/app.ts');
  const source = {
    description: '## Summary\n\nKeep the PR context visible.',
    number: 12,
    provider: 'github',
    title: 'Keep context visible in walkthrough',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/12',
  } satisfies ReviewSource;
  const narrativeWalkthrough = {
    agent: 'codex',
    chapters: [
      {
        blurb: 'Review the implementation.',
        icon: 'gear',
        id: 'impl',
        stops: [
          {
            added: 1,
            deleted: 1,
            hunkIds: ['src/app.ts:unstaged:h1'],
            hunks: [
              {
                added: 1,
                anchor: { display: 'src/app.ts', sectionId: 'src/app.ts:unstaged', side: 'both' },
                deleted: 1,
                id: 'src/app.ts:unstaged:h1',
                path: 'src/app.ts',
                status: 'modified',
              },
            ],
            id: 's1',
            importance: 'critical',
            prose: 'Review this file.',
            title: 'Implementation path',
          },
        ],
        title: 'Implementation',
      },
    ],
    focus: 'Focus.',
    generatedAt: '2026-06-07T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source,
    support: [],
    title: 'Narrative',
    version: 4,
  } satisfies NarrativeWalkthrough;

  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      source,
      walkthrough: true,
      walkthroughFile: '/tmp/walkthrough.json',
    })),
    getNarrativeWalkthrough: vi.fn(async () => ({
      status: 'ready' as const,
      walkthrough: narrativeWalkthrough,
    })),
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [changedFile],
      source,
    })),
  });

  const app = await renderReact(<App />);

  try {
    await waitFor(() => {
      expect(app.container.querySelector('.wt-stop-block')).not.toBeNull();
    });

    expect(app.container.querySelectorAll('.codiff-source-description-header')).toHaveLength(1);
    expect(app.container.querySelectorAll('.source-description-markdown')).toHaveLength(1);
    expect(app.container.textContent).toContain('Keep context visible in walkthrough');
    expect(app.container.textContent).toContain('Keep the PR context visible.');
  } finally {
    await app.cleanup();
  }
});

test('narrative walkthrough stops do not repeat commit details', async () => {
  const changedFile = createChangedFile('src/app.ts');
  const source = { ref: 'abc1234', type: 'commit' } satisfies ReviewSource;
  const commitMetadata = {
    author: {
      date: '2026-01-01T12:00:00Z',
      email: 'author@example.com',
      name: 'Author',
    },
    body: 'Detailed commit body.',
    committer: {
      date: '2026-01-01T13:00:00Z',
      email: 'committer@example.com',
      name: 'Committer',
    },
    files: [
      {
        additions: 1,
        binary: false,
        deletions: 1,
        path: 'src/app.ts',
        status: 'modified' as const,
      },
    ],
    parents: ['parent-sha'],
    ref: 'abc1234',
    refs: ['main'],
    shortRef: 'abc1234',
    signature: {
      status: 'N',
    },
    stats: {
      additions: 1,
      binaryFiles: 0,
      deletions: 1,
      files: 1,
      renamedFiles: 0,
    },
    subject: 'Commit subject',
    trailers: [],
  } satisfies CommitMetadata;
  const narrativeWalkthrough = {
    agent: 'codex',
    chapters: [
      {
        blurb: 'Review the implementation.',
        icon: 'gear',
        id: 'impl',
        stops: [
          {
            added: 1,
            deleted: 1,
            hunkIds: ['src/app.ts:unstaged:h1'],
            hunks: [
              {
                added: 1,
                anchor: { display: 'src/app.ts', sectionId: 'src/app.ts:unstaged', side: 'both' },
                deleted: 1,
                id: 'src/app.ts:unstaged:h1',
                path: 'src/app.ts',
                status: 'modified',
              },
            ],
            id: 's1',
            importance: 'critical',
            prose: 'Review this file without repeating the commit header.',
            title: 'Implementation path',
          },
        ],
        title: 'Implementation',
      },
    ],
    focus: 'Focus.',
    generatedAt: '2026-06-07T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source,
    support: [],
    title: 'Narrative',
    version: 4,
  } satisfies NarrativeWalkthrough;

  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      source,
      walkthrough: true,
      walkthroughFile: '/tmp/walkthrough.json',
    })),
    getNarrativeWalkthrough: vi.fn(async () => ({
      status: 'ready' as const,
      walkthrough: narrativeWalkthrough,
    })),
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      commitMetadata,
      files: [changedFile],
      source,
    })),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
      expect(container.querySelector('.wt-stop-block')).not.toBeNull();
    });

    expect(container.querySelector('.codiff-commit-details-header')).toBeNull();
    expect(container.querySelector('.commit-details-panel')).toBeNull();
    expect(container.querySelector('.wt-stage-title')?.textContent).toContain(
      'Implementation path',
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('a walkthrough file loads even without the walkthrough launch flag', async () => {
  const source = { ref: 'abc1234', type: 'commit' } satisfies ReviewSource;
  const narrativeWalkthrough = {
    agent: 'claude',
    chapters: [
      {
        blurb: 'Review the implementation.',
        icon: 'gear',
        id: 'impl',
        stops: [
          {
            added: 1,
            deleted: 1,
            hunkIds: ['src/app.ts:unstaged:h1'],
            hunks: [
              {
                added: 1,
                anchor: { display: 'src/app.ts', sectionId: 'src/app.ts:unstaged', side: 'both' },
                deleted: 1,
                id: 'src/app.ts:unstaged:h1',
                path: 'src/app.ts',
                status: 'modified',
              },
            ],
            id: 'implementation-path',
            importance: 'critical',
            prose: 'Review this file.',
            summary: 'The implementation path.',
            title: 'Implementation path',
          },
        ],
        title: 'Implementation',
      },
    ],
    focus: 'Focus.',
    generatedAt: '2026-06-07T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source,
    support: [],
    title: 'Narrative',
    version: 4,
  } satisfies NarrativeWalkthrough;

  const getNarrativeWalkthrough = vi.fn(async () => ({
    status: 'ready' as const,
    walkthrough: narrativeWalkthrough,
  }));
  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      source,
      walkthrough: false,
      walkthroughFile: '/tmp/walkthrough.json',
    })),
    getNarrativeWalkthrough,
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [createChangedFile('src/app.ts')],
      source,
    })),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.wt-stop-block')).not.toBeNull();
    });

    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.walkthrough-error')).toBeNull();
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('plan mode opens the Markdown editor without loading repository state', async () => {
  const getRepositoryState = vi.fn(async () => repositoryState);
  const completePlan = vi.fn(async (_review: PlanReview, _status: 'closed' | 'done') => {});
  const markPlanReady = vi.fn(async () => {});
  const sharePlan = vi.fn(async (_review: PlanReview) => ({
    status: 'uploaded' as const,
    url: 'https://codiff.dev/p/shared-plan',
  }));
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  const storedReview = {
    document: {
      id: 'stale-plan-id',
      path: '/tmp/old-plan.md',
      version: 'stale-version',
    },
    threads: [
      {
        anchor: {
          block: {
            fingerprint: 'heading-fingerprint',
            path: [1],
            text: 'Execute this plan',
            type: 'heading',
          },
          kind: 'block',
          version: 1,
        },
        createdAt: '2026-06-24T00:00:00.000Z',
        createdBy: {
          email: 'reviewer@example.com',
          id: 'reviewer@example.com',
          name: 'Reviewer',
        },
        id: 'thread-1',
        messages: [
          {
            author: {
              email: 'reviewer@example.com',
              id: 'reviewer@example.com',
              name: 'Reviewer',
            },
            body: 'Keep the rollout steps explicit.',
            createdAt: '2026-06-24T00:00:00.000Z',
            id: 'message-1',
            updatedAt: '2026-06-24T00:00:00.000Z',
          },
        ],
        status: 'open',
        updatedAt: '2026-06-24T00:00:00.000Z',
      },
      {
        anchor: {
          block: {
            fingerprint: 'list-item-fingerprint',
            path: [2, 0],
            text: 'First',
            type: 'listitem',
          },
          kind: 'block',
          version: 1,
        },
        createdAt: '2026-06-24T00:01:00.000Z',
        createdBy: {
          email: 'reviewer@example.com',
          id: 'reviewer@example.com',
          name: 'Reviewer',
        },
        id: 'empty-thread',
        messages: [
          {
            author: {
              email: 'reviewer@example.com',
              id: 'reviewer@example.com',
              name: 'Reviewer',
            },
            body: '   ',
            createdAt: '2026-06-24T00:01:00.000Z',
            id: 'empty-message',
            updatedAt: '2026-06-24T00:01:00.000Z',
          },
        ],
        status: 'open',
        updatedAt: '2026-06-24T00:01:00.000Z',
      },
    ],
    version: 1,
  } satisfies PlanReview;
  window.codiff = createCodiffMock({
    completePlan,
    getFeatureFlags: vi.fn(async () => ({
      planSharing: true,
      walkthroughSharing: false,
    })),
    getLaunchOptions: vi.fn(async () => ({
      planFile: '/tmp/plan.md',
      planResultFile: '/tmp/result.json',
      repositoryPathProvided: true,
      walkthrough: false,
    })),
    getMarkdownDocument: vi.fn(async () => ({
      content:
        '---\ntitle: Execute this plan\ndraft: true\n---\n\n# Execute this plan\n\n- First\n- Second\n\n```sh\nvp test\n```\n',
      id: 'plan:/tmp/plan.md',
      kind: 'plan' as const,
      path: '/tmp/plan.md',
      version: 'plan-version',
    })),
    getPlanReview: vi.fn(async () => storedReview),
    getRepositoryState,
    markPlanReady,
    sharePlan,
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.plan-shell')).not.toBeNull();
    });
    expect(getRepositoryState).not.toHaveBeenCalled();
    expect(markPlanReady).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.plan-title')?.textContent).toContain('plan.md');
    await waitFor(() => {
      expect(container.querySelector('[data-editor-type="frontmatter"]')).not.toBeNull();
    });
    expect(container.querySelector('.mdx-editor-content h2')).toBeNull();
    expect(container.querySelectorAll('.mdx-editor-content ul > li')).toHaveLength(2);
    await waitFor(() => {
      expect(container.querySelector('.cm-content')).not.toBeNull();
    });
    expect(container.querySelector('.cm-gutters')).toBeNull();
    expect(container.querySelector('.cm-content')?.textContent).toContain('vp test');
    await waitFor(() => {
      expect(container.querySelector('.plan-comment-thread')?.textContent).toContain(
        'Keep the rollout steps explicit.',
      );
    });
    const commentTargetButton = container.querySelector<HTMLButtonElement>('.plan-comment-target');
    expect(commentTargetButton?.textContent).toBe('Heading · Execute this plan');
    expect(commentTargetButton?.disabled).toBe(false);
    await act(async () => {
      commentTargetButton?.click();
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    scrollIntoView.mockClear();
    expect(container.querySelector('[data-mdx-annotation-block~="thread-1"]')).not.toBeNull();
    expect(container.querySelectorAll('li[data-mdx-comment-block-type="listitem"]')).toHaveLength(
      2,
    );

    const planWorkspace = container.querySelector<HTMLElement>('.plan-workspace');
    const editorContent = container.querySelector<HTMLElement>('.mdx-editor-content');
    const commentBlock = container.querySelectorAll<HTMLElement>(
      'li[data-mdx-comment-block-type="listitem"]',
    )[1];
    expect(planWorkspace).not.toBeNull();
    expect(editorContent).not.toBeNull();
    expect(commentBlock).toBeDefined();
    planWorkspace!.getBoundingClientRect = () => ({
      bottom: 700,
      height: 650,
      left: 100,
      right: 1100,
      toJSON: () => {},
      top: 50,
      width: 1000,
      x: 100,
      y: 50,
    });
    editorContent!.style.paddingRight = '24px';
    editorContent!.getBoundingClientRect = () => ({
      bottom: 650,
      height: 550,
      left: 120,
      right: 1020,
      toJSON: () => {},
      top: 100,
      width: 900,
      x: 120,
      y: 100,
    });
    commentBlock!.getBoundingClientRect = () => ({
      bottom: 224,
      height: 24,
      left: 144,
      right: 996,
      toJSON: () => {},
      top: 200,
      width: 852,
      x: 144,
      y: 200,
    });
    await act(async () => {
      commentBlock!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    });
    await waitFor(() => {
      expect(container.querySelector('.plan-comment-affordance')).not.toBeNull();
    });
    const commentAffordance = container.querySelector<HTMLElement>('.plan-comment-affordance')!;
    expect(commentAffordance.dataset.mdxCommentButton).toBe('');
    expect(commentAffordance.style.getPropertyValue('--plan-comment-left')).toBe('896px');
    expect(commentAffordance.style.getPropertyValue('--plan-comment-width')).toBe('48px');
    expect(commentAffordance.querySelector(':scope > .plan-comment-add')).not.toBeNull();
    await act(async () => {
      editorContent!.dispatchEvent(
        new MouseEvent('pointerleave', { relatedTarget: commentAffordance }),
      );
    });
    expect(container.querySelector('.plan-comment-affordance')).not.toBeNull();
    await act(async () => {
      commentAffordance.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: editorContent }),
      );
    });
    expect(container.querySelector('.plan-comment-affordance')).not.toBeNull();
    await act(async () => {
      commentAffordance.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: planWorkspace }),
      );
    });
    expect(container.querySelector('.plan-comment-affordance')).toBeNull();
    await act(async () => {
      container
        .querySelectorAll<HTMLElement>('li[data-mdx-comment-block-type="listitem"]')[0]!
        .dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
      commentBlock!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    });
    const addCommentButton = container.querySelector<HTMLButtonElement>('.plan-comment-add');
    expect(addCommentButton).not.toBeNull();
    await act(async () => {
      addCommentButton!.click();
    });
    const activeComment = container.querySelector<HTMLElement>('.plan-comment-thread.active');
    expect(activeComment).not.toBeNull();
    expect(activeComment!.closest<HTMLElement>('.plan-comment-position')?.style.top).not.toBe(
      '0px',
    );
    const activeCommentDelete =
      activeComment!.querySelector<HTMLButtonElement>('.review-comment-delete');
    expect(activeCommentDelete).not.toBeNull();
    await act(async () => {
      activeCommentDelete!.click();
    });

    const commentRail = container.querySelector<HTMLElement>('.plan-comment-rail-scroll');
    const commentPosition = container.querySelector<HTMLElement>('.plan-comment-position');
    const annotatedBlock = container.querySelector<HTMLElement>(
      '[data-mdx-annotation-block~="thread-1"]',
    );
    expect(commentRail).not.toBeNull();
    expect(commentPosition).not.toBeNull();
    expect(annotatedBlock).not.toBeNull();
    commentRail!.style.overflowY = 'auto';
    commentRail!.getBoundingClientRect = () => ({
      bottom: 300,
      height: 200,
      left: 0,
      right: 400,
      toJSON: () => {},
      top: 100,
      width: 400,
      x: 0,
      y: 100,
    });
    commentPosition!.getBoundingClientRect = () => ({
      bottom: 360,
      height: 100,
      left: 0,
      right: 400,
      toJSON: () => {},
      top: 260,
      width: 400,
      x: 0,
      y: 260,
    });
    const scrollCommentRail = vi.fn();
    commentRail!.scrollTo = scrollCommentRail;
    await act(async () => {
      annotatedBlock!.click();
    });
    await waitFor(() => {
      expect(scrollCommentRail).toHaveBeenCalledWith({ behavior: 'smooth', top: 68 });
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    const deleteButtons = container.querySelectorAll<HTMLButtonElement>('.review-comment-delete');
    expect(deleteButtons).toHaveLength(2);
    await act(async () => {
      deleteButtons[1]!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      deleteButtons[1]!.click();
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    const shareButton = container.querySelector<HTMLButtonElement>('.plan-share-button');
    expect(shareButton?.textContent).toContain('Share');
    await act(async () => {
      shareButton?.click();
    });
    await waitFor(() => {
      expect(sharePlan).toHaveBeenCalledTimes(1);
    });
    expect(sharePlan.mock.calls[0]?.[0].threads).toHaveLength(1);
    expect(shareButton?.textContent).toContain('Copied');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.plan-done-button')?.click();
    });
    await waitFor(() => {
      expect(completePlan).toHaveBeenCalledTimes(1);
    });
    expect(completePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        document: {
          id: 'plan:/tmp/plan.md',
          path: '/tmp/plan.md',
          version: 'plan-version',
        },
        threads: [
          expect.objectContaining({
            id: 'thread-1',
            messages: [
              expect.objectContaining({
                body: 'Keep the rollout steps explicit.',
              }),
            ],
          }),
        ],
        version: 1,
      }),
      'done',
    );
    expect(completePlan.mock.calls[0]?.[0].threads).toHaveLength(1);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    container.remove();
  }
});

test('plan mode resolves stored comments whose anchors were already removed', async () => {
  const savePlanReview = vi.fn(async (review: PlanReview) => review);
  const storedReview = {
    document: {
      id: 'plan:/tmp/plan.md',
      path: '/tmp/plan.md',
      version: 'old-plan-version',
    },
    threads: [
      {
        anchor: {
          block: {
            fingerprint: 'removed-heading-fingerprint',
            path: [99],
            text: 'Removed heading',
            type: 'heading',
          },
          kind: 'block',
          version: 1,
        },
        createdAt: '2026-06-24T00:00:00.000Z',
        createdBy: {
          email: 'reviewer@example.com',
          id: 'reviewer@example.com',
          name: 'Reviewer',
        },
        id: 'detached-thread',
        messages: [
          {
            author: {
              email: 'reviewer@example.com',
              id: 'reviewer@example.com',
              name: 'Reviewer',
            },
            body: 'Keep this comment as history.',
            createdAt: '2026-06-24T00:00:00.000Z',
            id: 'detached-message',
            updatedAt: '2026-06-24T00:00:00.000Z',
          },
        ],
        status: 'open',
        updatedAt: '2026-06-24T00:00:00.000Z',
      },
    ],
    version: 1,
  } satisfies PlanReview;
  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      planFile: '/tmp/plan.md',
      planResultFile: '/tmp/result.json',
      repositoryPathProvided: true,
      walkthrough: false,
    })),
    getMarkdownDocument: vi.fn(async () => ({
      content: '# Current plan\n',
      id: 'plan:/tmp/plan.md',
      kind: 'plan' as const,
      path: '/tmp/plan.md',
      version: 'plan-version',
    })),
    getPlanReview: vi.fn(async () => storedReview),
    savePlanReview,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<App />);
    });
    await waitFor(() => {
      expect(savePlanReview).toHaveBeenCalledWith(
        expect.objectContaining({
          threads: [
            expect.objectContaining({
              id: 'detached-thread',
              resolution: expect.objectContaining({
                reason: 'anchor-removed',
                resolvedAt: expect.any(String),
              }),
              status: 'resolved',
            }),
          ],
        }),
      );
    });

    const resolvedSection = container.querySelector<HTMLDetailsElement>('.plan-resolved-comments');
    expect(resolvedSection?.open).toBe(false);
    expect(resolvedSection?.querySelector('summary')?.textContent).toBe('Resolved comments (1)');
    expect(container.querySelector('.plan-comment-thread.resolved')?.textContent).toContain(
      'Resolved after target removal',
    );
    expect(container.querySelector('[data-mdx-annotation-block~="detached-thread"]')).toBeNull();

    await act(async () => {
      resolvedSection!.open = true;
      resolvedSection!.dispatchEvent(new Event('toggle'));
    });
    await act(async () => {
      resolvedSection?.querySelector<HTMLButtonElement>('.review-comment-delete')?.click();
    });
    await waitFor(() => {
      expect(container.querySelector('.plan-resolved-comments')).toBeNull();
      expect(savePlanReview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          threads: [],
        }),
      );
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('plan mode keeps comments open when their anchors are removed during the current review', async () => {
  let publishMarkdownChange:
    | ((change: {
        deleted: boolean;
        document: {
          content: string;
          id: string;
          kind: 'plan';
          path: string;
          version: string;
        };
        id: string;
      }) => void)
    | null = null;
  const savePlanReview = vi.fn(async (review: PlanReview) => review);
  const storedReview = {
    document: {
      id: 'plan:/tmp/plan.md',
      path: '/tmp/plan.md',
      version: 'plan-version',
    },
    threads: [
      {
        anchor: {
          block: {
            fingerprint: 'heading-fingerprint',
            path: [0],
            text: 'Current plan',
            type: 'heading',
          },
          kind: 'block',
          version: 1,
        },
        createdAt: '2026-06-24T00:00:00.000Z',
        createdBy: {
          email: 'reviewer@example.com',
          id: 'reviewer@example.com',
          name: 'Reviewer',
        },
        id: 'live-thread',
        messages: [
          {
            author: {
              email: 'reviewer@example.com',
              id: 'reviewer@example.com',
              name: 'Reviewer',
            },
            body: 'The agent still needs to process this.',
            createdAt: '2026-06-24T00:00:00.000Z',
            id: 'live-message',
            updatedAt: '2026-06-24T00:00:00.000Z',
          },
        ],
        status: 'open',
        updatedAt: '2026-06-24T00:00:00.000Z',
      },
    ],
    version: 1,
  } satisfies PlanReview;
  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      planFile: '/tmp/plan.md',
      planResultFile: '/tmp/result.json',
      repositoryPathProvided: true,
      walkthrough: false,
    })),
    getMarkdownDocument: vi.fn(async () => ({
      content: '# Current plan\n',
      id: 'plan:/tmp/plan.md',
      kind: 'plan' as const,
      path: '/tmp/plan.md',
      version: 'plan-version',
    })),
    getPlanReview: vi.fn(async () => storedReview),
    onMarkdownDocumentChanged: vi.fn((callback) => {
      publishMarkdownChange = callback;
      return () => {
        publishMarkdownChange = null;
      };
    }),
    savePlanReview,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<App />);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-mdx-annotation-block~="live-thread"]')).not.toBeNull();
      expect(publishMarkdownChange).not.toBeNull();
    });
    savePlanReview.mockClear();

    await act(async () => {
      publishMarkdownChange?.({
        deleted: false,
        document: {
          content: '# Replacement plan\n',
          id: 'plan:/tmp/plan.md',
          kind: 'plan',
          path: '/tmp/plan.md',
          version: 'next-plan-version',
        },
        id: 'plan:/tmp/plan.md',
      });
    });
    await waitFor(() => {
      expect(container.querySelector('[data-mdx-annotation-block~="live-thread"]')).toBeNull();
    });

    expect(container.querySelector('.plan-resolved-comments')).toBeNull();
    expect(container.querySelector('.plan-comment-position .plan-comment-thread')).not.toBeNull();
    expect(
      savePlanReview.mock.calls.some(
        ([review]) =>
          review.threads.find((thread) => thread.id === 'live-thread')?.status === 'resolved',
      ),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('closing plan mode flushes and returns a closed handoff', async () => {
  const completePlan = vi.fn(async (_review: PlanReview, _status: 'closed' | 'done') => {});
  let blockPlanReviewSave = false;
  let resolvePlanReviewSave: (() => void) | null = null;
  const savePlanReview = vi.fn((review: PlanReview) => {
    if (!blockPlanReviewSave) {
      return Promise.resolve(review);
    }
    return new Promise<PlanReview>((resolveSave) => {
      resolvePlanReviewSave = () => resolveSave(review);
    });
  });
  let requestClose: (() => void) | null = null;
  window.codiff = createCodiffMock({
    completePlan,
    getLaunchOptions: vi.fn(async () => ({
      planFile: '/tmp/plan.md',
      planResultFile: '/tmp/result.json',
      repositoryPathProvided: true,
      walkthrough: false,
    })),
    getMarkdownDocument: vi.fn(async () => ({
      content: '# Execute this plan\n',
      id: 'plan:/tmp/plan.md',
      kind: 'plan' as const,
      path: '/tmp/plan.md',
      version: 'plan-version',
    })),
    getPlanReview: vi.fn(
      async (): Promise<PlanReview> => ({
        document: {
          id: 'plan:/tmp/plan.md',
          path: '/tmp/plan.md',
          version: 'plan-version',
        },
        threads: [
          {
            anchor: {
              block: {
                fingerprint: 'heading-fingerprint',
                path: [0],
                text: 'Execute this plan',
                type: 'heading',
              },
              kind: 'block',
              version: 1,
            },
            createdAt: '2026-06-24T00:00:00.000Z',
            createdBy: {
              email: 'reviewer@example.com',
              id: 'reviewer@example.com',
              name: 'Reviewer',
            },
            id: 'thread-1',
            messages: [
              {
                author: {
                  email: 'reviewer@example.com',
                  id: 'reviewer@example.com',
                  name: 'Reviewer',
                },
                body: 'Keep this requirement.',
                createdAt: '2026-06-24T00:00:00.000Z',
                id: 'message-1',
                updatedAt: '2026-06-24T00:00:00.000Z',
              },
            ],
            status: 'open',
            updatedAt: '2026-06-24T00:00:00.000Z',
          },
        ],
        version: 1,
      }),
    ),
    onPlanCloseRequested: vi.fn((callback) => {
      requestClose = callback;
      return () => {
        requestClose = null;
      };
    }),
    savePlanReview,
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.plan-shell')).not.toBeNull();
      expect(requestClose).not.toBeNull();
      expect(container.querySelector('.plan-comment-thread')).not.toBeNull();
    });
    await act(async () => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 75));
    });
    savePlanReview.mockClear();
    blockPlanReviewSave = true;
    await act(async () => {
      requestClose?.();
    });
    await waitFor(() => {
      expect(savePlanReview).toHaveBeenCalledTimes(1);
    });
    expect(completePlan).not.toHaveBeenCalled();
    expect(
      [...container.querySelectorAll<HTMLElement>('[contenteditable]')].map((element) =>
        element.getAttribute('contenteditable'),
      ),
    ).toEqual(['false', 'false']);
    expect(container.querySelector<HTMLButtonElement>('.review-comment-delete')?.disabled).toBe(
      true,
    );
    await act(async () => {
      resolvePlanReviewSave?.();
    });
    await waitFor(() => {
      expect(completePlan).toHaveBeenCalledTimes(1);
    });
    expect(completePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        document: {
          id: 'plan:/tmp/plan.md',
          path: '/tmp/plan.md',
          version: 'plan-version',
        },
        threads: [
          expect.objectContaining({
            id: 'thread-1',
          }),
        ],
        version: 1,
      }),
      'closed',
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('plan mode recovers from an unreadable review sidecar', async () => {
  const markPlanReady = vi.fn(async () => {});
  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      planFile: '/tmp/plan.md',
      planResultFile: '/tmp/result.json',
      repositoryPathProvided: true,
      walkthrough: false,
    })),
    getMarkdownDocument: vi.fn(async () => ({
      content: '# Execute this plan\n',
      id: 'plan:/tmp/plan.md',
      kind: 'plan' as const,
      path: '/tmp/plan.md',
      version: 'plan-version',
    })),
    getPlanReview: vi.fn(async () => {
      throw new Error('Invalid plan review.');
    }),
    markPlanReady,
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.plan-shell')).not.toBeNull();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Invalid plan review.',
    );
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
    expect(markPlanReady).toHaveBeenCalledTimes(1);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('a walkthrough file that no longer anchors surfaces a dismissible banner', async () => {
  const source = { ref: 'abc1234', type: 'commit' } satisfies ReviewSource;
  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      source,
      walkthrough: false,
      walkthroughFile: '/tmp/broken-walkthrough.json',
    })),
    getNarrativeWalkthrough: vi.fn(async () => ({
      reason: 'These changes were committed since the walkthrough was authored.',
      status: 'unavailable' as const,
    })),
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [createChangedFile('src/app.ts')],
      source,
    })),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.walkthrough-outdated-banner.visible')).not.toBeNull();
    });

    const banner = container.querySelector('.walkthrough-outdated-banner');
    expect(banner?.textContent).toContain('committed since the walkthrough was authored');
    expect(banner?.textContent).toContain('Showing history instead.');

    await act(async () => {
      banner?.querySelector<HTMLButtonElement>('.repository-change-dismiss')?.click();
    });

    expect(container.querySelector('.walkthrough-outdated-banner.visible')).toBeNull();
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('repository changes show the update banner without refreshing the working tree', async () => {
  let onRepositoryChanged: ((change: { root: string }) => void) | null = null;
  const getRepositoryState = vi.fn(async () => repositoryState);

  window.codiff = createCodiffMock({
    getRepositoryState,
    onRepositoryChanged: vi.fn((callback) => {
      onRepositoryChanged = callback;
      return () => {
        onRepositoryChanged = null;
      };
    }),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
      expect(onRepositoryChanged).not.toBeNull();
    });

    expect(container.querySelector('.repository-change-banner.visible')).toBeNull();
    expect(getRepositoryState).toHaveBeenCalledTimes(1);

    await act(async () => {
      onRepositoryChanged?.({ root: '/repo' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('.repository-change-banner.visible')).not.toBeNull();
    expect(getRepositoryState).toHaveBeenCalledTimes(1);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('clicking the change banner refreshes the repository in place', async () => {
  const initialFile = {
    fingerprint: 'src/app.ts:1',
    path: 'src/app.ts',
    sections: [
      {
        binary: false,
        id: 'src/app.ts:unstaged',
        kind: 'unstaged',
        patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;
  const addedFile = {
    fingerprint: 'src/added.ts:1',
    path: 'src/added.ts',
    sections: [
      {
        binary: false,
        id: 'src/added.ts:unstaged',
        kind: 'unstaged',
        patch: 'diff --git a/src/added.ts b/src/added.ts\n@@ -0,0 +1 @@\n+created\n',
      },
    ],
    status: 'added',
  } satisfies ChangedFile;

  let onRepositoryChanged: ((change: { root: string }) => void) | null = null;
  let stateRequests = 0;
  const getRepositoryState = vi.fn<Window['codiff']['getRepositoryState']>(async () => {
    stateRequests += 1;
    return stateRequests === 1
      ? { ...repositoryState, files: [initialFile] }
      : {
          ...repositoryState,
          files: [
            addedFile,
            {
              ...initialFile,
              fingerprint: 'src/app.ts:2',
              sections: [
                {
                  binary: false,
                  id: 'src/app.ts:unstaged',
                  kind: 'unstaged',
                  patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+newer\n',
                },
              ],
            },
          ],
        };
  });

  window.codiff = createCodiffMock({
    getRepositoryState,
    onRepositoryChanged: vi.fn((callback) => {
      onRepositoryChanged = callback;
      return () => {
        onRepositoryChanged = null;
      };
    }),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
      expect(onRepositoryChanged).not.toBeNull();
    });
    expect(container.textContent).not.toContain('added.ts');

    await act(async () => {
      onRepositoryChanged?.({ root: '/repo' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const refreshButton = container.querySelector<HTMLButtonElement>('.repository-change-reload');
    expect(refreshButton).not.toBeNull();
    await act(async () => {
      refreshButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // New file appears without a window reload, and the banner clears.
    expect(getRepositoryState).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('added.ts');
    expect(container.querySelector('.repository-change-banner.visible')).toBeNull();

    // The changed file must not appear twice (old + new version).
    const appOccurrences = container.textContent?.split('app.ts').length ?? 1;
    expect(appOccurrences - 1).toBeLessThanOrEqual(2);
    expect(container.textContent).not.toContain('-old\n+new\n');
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('walkthrough launch errors stay on the walkthrough tab without automatic retries', async () => {
  const changedFile = {
    fingerprint: 'src/app.ts:1',
    path: 'src/app.ts',
    sections: [
      {
        binary: false,
        id: 'src/app.ts:unstaged',
        kind: 'unstaged',
        patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;
  const getNarrativeWalkthrough = vi.fn(async () => ({
    reason: 'Codex walkthrough timed out.',
    status: 'unavailable' as const,
  }));

  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      walkthrough: true,
    })),
    getNarrativeWalkthrough,
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [changedFile],
    })),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  const getTab = (label: string) =>
    Array.from(container.querySelectorAll('button[role="tab"]')).find((button) =>
      button.textContent?.includes(label),
    ) as HTMLButtonElement | undefined;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Walkthrough unavailable');
    });

    expect(getTab('Walkthrough')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.sidebar-walkthrough-status')).not.toBeNull();
    expect(container.querySelector('.sidebar .file-tree-shell')).toBeNull();
    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(1);

    await act(async () => {
      getTab('Tree')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      getTab('Walkthrough')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Walkthrough unavailable');
    expect(container.querySelector('.sidebar .file-tree-shell')).toBeNull();
    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(1);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});
test('history filter matches commits by author name', async () => {
  window.codiff = createCodiffMock({
    getRepositoryHistory: vi.fn(async () => ({
      entries: [
        {
          author: 'Ada Lovelace',
          committedAt: Date.now(),
          parents: [],
          ref: 'aaa1111',
          subject: 'Fix parser',
        },
        {
          author: 'Grace Hopper',
          committedAt: Date.now(),
          parents: [],
          ref: 'bbb2222',
          subject: 'Update docs',
        },
      ],
      root: '/repo',
    })),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  const findButton = (label: string) =>
    Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(label),
    );
  const historySubjects = () =>
    Array.from(container.querySelectorAll('.history-entry-subject')).map(
      (element) => element.textContent,
    );

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.querySelector('.loading')).toBeNull();
    });

    await act(async () => {
      findButton('History')?.click();
    });

    await waitFor(() => {
      expect(historySubjects()).toContain('Fix parser');
      expect(historySubjects()).toContain('Update docs');
    });

    const searchInput = container.querySelector<HTMLInputElement>('.sidebar-search');
    expect(searchInput).toBeTruthy();
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setInputValue?.call(searchInput, 'grace');
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await waitFor(() => {
      expect(historySubjects()).toContain('Update docs');
      expect(historySubjects()).not.toContain('Fix parser');
    });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('Pi not-found walkthrough errors show the agent recovery panel', async () => {
  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      agentBackend: 'pi' as const,
      repositoryPathProvided: true,
      walkthrough: true,
    })),
    getNarrativeWalkthrough: vi.fn(async () => ({
      code: 'PI_NOT_FOUND' as const,
      reason: 'Pi CLI was not found.',
      status: 'unavailable' as const,
    })),
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [createChangedFile('src/app.ts')],
    })),
  });

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Pi CLI not found');
    });

    expect(container.textContent).toContain('Pi CLI was not found.');
    expect(container.textContent).toContain('Review Files');
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});
