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
import type { ChangedFile, CommitMetadata, RepositoryState, ReviewSource } from '../types.ts';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
  ResizeObserver?: typeof ResizeObserver;
  Worker?: typeof Worker;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
reactActEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
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
});

const repositoryState = {
  branch: 'main',
  files: [],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;

const createChangedFile = (path: string, fingerprint = `${path}:1`) =>
  ({
    fingerprint,
    path,
    sections: [
      {
        binary: false,
        id: `${path}:unstaged`,
        kind: 'unstaged',
        patch: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
      },
    ],
    status: 'modified',
  }) satisfies ChangedFile;

const waitFor = async (assertion: () => void) => {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  throw lastError;
};

const createCodiffMock = (overrides: Partial<Window['codiff']> = {}): Window['codiff'] => ({
  askReviewAssistant: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  getCodexSkillStatus: vi.fn(async () => ({
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
  getPreferences: vi.fn(async () => ({
    copyCommentsOnClose: true,
    diffStyle: 'split' as const,
    editorCommand: '',
    lastRepositoryPath: '/repo',
    openAIModel: defaultSettings.openAIModel,
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
  getWalkthrough: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  installCodexSkill: vi.fn(async () => ({
    installed: true,
    path: '/Users/reviewer/.codex/skills/codiff',
  })),
  installTerminalHelper: vi.fn(async () => ({
    command: 'codiff',
    installed: true,
    path: '/usr/local/bin/codiff',
  })),
  onConfigChanged: vi.fn(() => () => {}),
  onCopyPendingCommentsRequest: vi.fn(() => () => {}),
  onFindInDiffs: vi.fn(() => () => {}),
  onRepositoryChanged: vi.fn(() => () => {}),
  openConfigFile: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
  setDiffStyle: vi.fn(async () => {}),
  setShowOutdated: vi.fn(async () => {}),
  setWordWrap: vi.fn(async () => {}),
  showInFolder: vi.fn(async () => {}),
  submitPullRequestComment: vi.fn(async () => {
    throw new Error('Unexpected pull request comment submit.');
  }),
  submitPullRequestReview: vi.fn(async () => {}),
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

test('repository reload colors only git status glyphs for files changed after reload', async () => {
  const unchangedFile = createChangedFile('src/unchanged.ts', 'same');
  const changedFileBeforeReload = createChangedFile('src/changed.ts', 'before');
  const changedFileAfterReload = createChangedFile('src/changed.ts', 'after');
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
  const getWalkthrough = vi.fn(async () => ({
    reason: 'Codex walkthrough timed out.',
    status: 'unavailable' as const,
  }));

  window.codiff = createCodiffMock({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      walkthrough: true,
    })),
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [changedFile],
    })),
    getWalkthrough,
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
    expect(getWalkthrough).toHaveBeenCalledTimes(1);

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
    expect(getWalkthrough).toHaveBeenCalledTimes(1);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});
