/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import App from '../App.tsx';
import { defaultConfig } from '../config/defaults.ts';
import type { ChangedFile, RepositoryState } from '../types.ts';

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

const repositoryState = {
  branch: 'main',
  files: [],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;

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

test('repository changes show the update banner without refreshing the working tree', async () => {
  let onRepositoryChanged: ((change: { root: string }) => void) | null = null;
  const getRepositoryState = vi.fn(async () => repositoryState);

  window.codiff = {
    askReviewAssistant: vi.fn(async () => ({
      reason: 'Unavailable in tests.',
      status: 'unavailable' as const,
    })),
    getCodexSkillStatus: vi.fn(async () => ({
      installed: true,
      path: '/Users/reviewer/.codex/skills/codiff',
    })),
    getConfig: vi.fn(async () => defaultConfig),
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
      lastRepositoryPath: '/repo',
      openAIModel: defaultConfig.settings.openAIModel,
      showOutdated: false,
      showWhitespace: false,
      theme: 'system' as const,
    })),
    getRepositoryHistory: vi.fn(async () => ({
      entries: [],
      root: '/repo',
    })),
    getRepositoryState,
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
    onRepositoryChanged: vi.fn((callback) => {
      onRepositoryChanged = callback;
      return () => {
        onRepositoryChanged = null;
      };
    }),
    openConfigFile: vi.fn(async () => {}),
    openFile: vi.fn(async () => {}),
    setDiffStyle: vi.fn(async () => {}),
    setShowOutdated: vi.fn(async () => {}),
    showInFolder: vi.fn(async () => {}),
    submitPullRequestComment: vi.fn(async () => {
      throw new Error('Unexpected pull request comment submit.');
    }),
    submitPullRequestReview: vi.fn(async () => {}),
  };

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

  window.codiff = {
    askReviewAssistant: vi.fn(async () => ({
      reason: 'Unavailable in tests.',
      status: 'unavailable' as const,
    })),
    getCodexSkillStatus: vi.fn(async () => ({
      installed: true,
      path: '/Users/reviewer/.codex/skills/codiff',
    })),
    getConfig: vi.fn(async () => defaultConfig),
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
      walkthrough: true,
    })),
    getPreferences: vi.fn(async () => ({
      copyCommentsOnClose: true,
      diffStyle: 'split' as const,
      lastRepositoryPath: '/repo',
      openAIModel: defaultConfig.settings.openAIModel,
      showOutdated: false,
      showWhitespace: false,
      theme: 'system' as const,
    })),
    getRepositoryHistory: vi.fn(async () => ({
      entries: [],
      root: '/repo',
    })),
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [changedFile],
    })),
    getTerminalHelperStatus: vi.fn(async () => ({
      command: 'codiff',
      installed: true,
      path: '/usr/local/bin/codiff',
    })),
    getWalkthrough,
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
    showInFolder: vi.fn(async () => {}),
    submitPullRequestComment: vi.fn(async () => {
      throw new Error('Unexpected pull request comment submit.');
    }),
    submitPullRequestReview: vi.fn(async () => {}),
  };

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
