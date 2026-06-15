/**
 * @vitest-environment jsdom
 */

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
  RepositoryState,
  ReviewSource,
} from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { waitFor } from './helpers/react.tsx';

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
  getGitIdentity: vi.fn(async () => ({
    email: 'reviewer@example.com',
    name: 'Reviewer',
  })),
  getLaunchOptions: vi.fn(async () => ({
    repositoryPathProvided: true,
    walkthrough: false,
  })),
  getNarrativeWalkthrough: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
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
    piModel: defaultSettings.piModel,
    showOutdated: false,
    showWhitespace: false,
    theme: 'system' as const,
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
  onConfigChanged: vi.fn(() => () => {}),
  onCopyPendingCommentsRequest: vi.fn(() => () => {}),
  onFindInDiffs: vi.fn(() => () => {}),
  onRepositoryChanged: vi.fn(() => () => {}),
  onWindowFullScreenChanged: vi.fn(() => () => {}),
  openConfigFile: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
  resetCodeFontSize: vi.fn(async () => {}),
  setDiffStyle: vi.fn(async () => {}),
  setShowOutdated: vi.fn(async () => {}),
  setWordWrap: vi.fn(async () => {}),
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
    expect(container.querySelector('.codiff-file-header.selected')).not.toBeNull();
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
      expect(
        container.querySelector('.codiff-file-header.selected .codiff-file-path')?.textContent,
      ).toBe(secondFile.path);
    });
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
      expect(
        container.querySelector('.codiff-file-header.selected .codiff-file-path')?.textContent,
      ).toBe(secondFile.path);
    });
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
      reason: 'Pi support could not be loaded.',
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
      expect(container.textContent).toContain('Pi support not found');
    });

    expect(container.textContent).toContain('Pi support could not be loaded.');
    expect(container.textContent).toContain('Review Files');
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});
