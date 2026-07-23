/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import App from '../App.tsx';
import { createDefaultConfig } from '../config/defaults.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const installWindowApi = ({
  installAgentSkill = vi.fn(async () => ({ installed: true, path: '/skill' })),
  installTerminalHelper = vi.fn(async () => ({
    command: 'codiff',
    installed: true,
    path: '/usr/local/bin/codiff',
  })),
  repositoryPathProvided = false,
}: {
  installAgentSkill?: ReturnType<typeof vi.fn>;
  installTerminalHelper?: ReturnType<typeof vi.fn>;
  repositoryPathProvided?: boolean;
} = {}) => {
  const api = {
    getAgentSkillStatus: vi.fn(async () => ({ installed: false, path: '/skill' })),
    getConfig: vi.fn(async () => createDefaultConfig()),
    getFeatureFlags: vi.fn(async () => ({ planSharing: false, walkthroughSharing: false })),
    getGitIdentity: vi.fn(async () => null),
    getLaunchOptions: vi.fn(async () => ({ repositoryPathProvided, walkthrough: false })),
    getRepositoryState: vi.fn(async () => {
      throw new Error('fatal: not a git repository');
    }),
    getTerminalHelperStatus: vi.fn(async () => ({
      command: 'codiff',
      installed: false,
      path: '/usr/local/bin/codiff',
    })),
    installAgentSkill,
    installTerminalHelper,
    onConfigChanged: vi.fn(() => () => {}),
  };
  window.codiff = api as unknown as Window['codiff'];
  return api;
};

test('a non-repository launch renders first-run guidance and install actions', async () => {
  const api = installWindowApi();
  await using view = await renderReact(<App />);

  await waitFor(() => expect(view.container.textContent).toContain('Open a Git repository'));
  expect(view.container.textContent).toContain('Install Terminal Helper');
  expect(view.container.textContent).toContain('Install Codex Skill');

  await act(async () =>
    Array.from(view.container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Install Codex Skill')
      ?.click(),
  );
  await waitFor(() => expect(api.installAgentSkill).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.container.textContent).not.toContain('Install Codex Skill'));
});

test('an explicit invalid repository path renders the repository error instead of first-run', async () => {
  installWindowApi({ repositoryPathProvided: true });
  await using view = await renderReact(<App />);

  await waitFor(() => expect(view.container.textContent).toContain('No Git repository found'));
  expect(view.container.textContent).not.toContain('Install Terminal Helper');
});

test('terminal-helper install success exits first-run and failure restores the action', async () => {
  const successfulInstall = vi.fn(async () => ({
    command: 'codiff',
    installed: true,
    path: '/usr/local/bin/codiff',
  }));
  installWindowApi({ installTerminalHelper: successfulInstall });
  await using success = await renderReact(<App />);
  await waitFor(() => expect(success.container.textContent).toContain('Install Terminal Helper'));
  await act(async () =>
    Array.from(success.container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Install Terminal Helper')
      ?.click(),
  );
  await waitFor(() => expect(successfulInstall).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(success.container.textContent).toContain('No Git repository found'));

  const failedInstall = vi.fn(async () => {
    throw new Error('Install failed.');
  });
  installWindowApi({ installTerminalHelper: failedInstall });
  await using failure = await renderReact(<App />);
  await waitFor(() => expect(failure.container.textContent).toContain('Install Terminal Helper'));
  await act(async () =>
    Array.from(failure.container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Install Terminal Helper')
      ?.click(),
  );
  await waitFor(() => expect(failedInstall).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(failure.container.textContent).toContain('Install Terminal Helper'));
});
