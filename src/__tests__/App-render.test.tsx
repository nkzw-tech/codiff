/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import App from '../App.tsx';
import { defaultConfig } from '../config/defaults.ts';
import type { RepositoryState } from '../types.ts';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

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
