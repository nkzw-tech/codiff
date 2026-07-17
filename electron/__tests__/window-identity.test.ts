import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { findMatchingWindowIdentity, getWindowIdentity, getWindowIdentityForRepositoryState } =
  require('../window-identity.cjs') as {
    findMatchingWindowIdentity: (
      identity: { key: string } | null,
      existingIdentities: ReadonlyMap<number, { key: string } | null>,
    ) => number | null;
    getWindowIdentity: (
      repositoryPath: string,
      launchOptions?: {
        source?:
          | { type: 'working-tree' }
          | { ref: string; type: 'branch' }
          | { baseRef: string; headRef: string; ref: string; type: 'branch-diff' }
          | { ref: string; type: 'commit' }
          | {
              number?: number;
              owner?: string;
              repo?: string;
              type: 'pull-request';
              url: string;
            };
        walkthrough?: boolean;
        walkthroughFile?: string;
        planFile?: string;
        planResultFile?: string;
      },
    ) => { key: string; repositoryRoot: string; sourceKey: string } | null;
    getWindowIdentityForRepositoryState: (state: {
      root: string;
      source:
        | { type: 'working-tree' }
        | { ref: string; type: 'commit' }
        | { baseRef: string; headRef: string; ref: string; type: 'branch-diff' };
    }) => { key: string; repositoryRoot: string; sourceKey: string } | null;
  };

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) => {
  const result = await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironment(),
  });
  return result.stdout.trim();
};

const initRepository = async (path: string) => {
  await git(path, ['init']);
  await git(path, ['commit', '--allow-empty', '-m', 'initial']);
};

test.sequential('plan window identities do not invoke Git outside repositories', async () => {
  await using directory = await createTemporaryDirectory('codiff-plan-window-identity-');
  const fakeBin = join(directory.path, 'bin');
  const gitMarker = join(directory.path, 'git-invoked');
  const planFile = join(directory.path, 'plan.md');
  await using _environment = createTemporaryEnvironment({
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  });

  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/bin/sh\nprintf invoked > "${gitMarker}"\nexit 99\n`);
  await chmod(join(fakeBin, 'git'), 0o755);
  await writeFile(planFile, '# Plan\n');
  const realDirectory = await realpath(directory.path);
  const realPlanFile = await realpath(planFile);

  expect(
    getWindowIdentity(directory.path, {
      planFile,
      planResultFile: join(directory.path, 'result.json'),
    }),
  ).toMatchObject({
    repositoryRoot: realDirectory,
    sourceKey: `plan:${realPlanFile}`,
  });
  expect(await readFile(gitMarker, 'utf8').catch(() => null)).toBeNull();
});

test('window identities match working-tree launches inside the same repository', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-identity-');
  await initRepository(directory.path);

  const nestedPath = join(directory.path, 'src');
  await mkdir(nestedPath);

  expect(getWindowIdentity(nestedPath)?.key).toBe(getWindowIdentity(directory.path)?.key);
});

test('window identities resolve commit refs to the same commit sha', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-identity-');
  await initRepository(directory.path);

  const head = await git(directory.path, ['rev-parse', 'HEAD']);

  expect(
    getWindowIdentity(directory.path, {
      source: { ref: 'HEAD', type: 'commit' },
    })?.sourceKey,
  ).toBe(`commit:${head}`);
  expect(
    getWindowIdentity(directory.path, {
      source: { ref: head.slice(0, 8), type: 'commit' },
    })?.key,
  ).toBe(
    getWindowIdentity(directory.path, {
      source: { ref: 'HEAD', type: 'commit' },
    })?.key,
  );
});

test.sequential('resolved repository states build identities without invoking Git', async () => {
  await using repository = await createTemporaryDirectory('codiff-window-identity-');
  await initRepository(repository.path);
  await using fakeBin = await createTemporaryDirectory('codiff-resolved-window-identity-');
  const gitMarker = join(fakeBin.path, 'git-invoked');
  await using _environment = createTemporaryEnvironment({
    PATH: `${fakeBin.path}:${process.env.PATH ?? ''}`,
  });

  const head = await git(repository.path, ['rev-parse', 'HEAD']);
  await writeFile(
    join(fakeBin.path, 'git'),
    `#!/bin/sh\nprintf invoked > "${gitMarker}"\nexit 99\n`,
  );
  await chmod(join(fakeBin.path, 'git'), 0o755);

  expect(
    getWindowIdentityForRepositoryState({
      root: repository.path,
      source: { ref: head, type: 'commit' },
    }),
  ).toMatchObject({
    repositoryRoot: await realpath(repository.path),
    sourceKey: `commit:${head}`,
  });
  expect(await readFile(gitMarker, 'utf8').catch(() => null)).toBeNull();
});

test('implicit walkthrough identities use HEAD only when the working tree is clean', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-identity-');
  await initRepository(directory.path);

  const headIdentity = getWindowIdentity(directory.path, {
    source: { ref: 'HEAD', type: 'commit' },
  });
  expect(getWindowIdentity(directory.path, { walkthrough: true })?.key).toBe(headIdentity?.key);

  await writeFile(join(directory.path, 'local.txt'), 'change\n');
  expect(getWindowIdentity(directory.path, { walkthrough: true })?.sourceKey).toBe('working-tree');

  await rm(join(directory.path, 'local.txt'));
  expect(
    getWindowIdentity(directory.path, {
      walkthrough: true,
      walkthroughFile: '/tmp/walkthrough.json',
    })?.sourceKey,
  ).toBe('working-tree');
});

test('window identities distinguish branch history launches', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-identity-');
  await initRepository(directory.path);

  await git(directory.path, ['checkout', '-b', 'feature']);
  const head = (await git(directory.path, ['rev-parse', 'HEAD'])).trim().toLowerCase();

  expect(
    getWindowIdentity(directory.path, {
      source: { ref: 'feature', type: 'branch' },
    })?.sourceKey,
  ).toBe(`branch-diff:feature:${head}:${head}`);

  await git(directory.path, ['commit', '--allow-empty', '-m', 'feature update']);
  const nextHead = (await git(directory.path, ['rev-parse', 'HEAD'])).trim().toLowerCase();

  expect(
    getWindowIdentity(directory.path, {
      source: { baseRef: head, headRef: nextHead, ref: 'feature', type: 'branch-diff' },
    })?.sourceKey,
  ).toBe(`branch-diff:feature:${head}:${nextHead}`);
});

test('window identities normalize GitHub pull request sources', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-identity-');
  await initRepository(directory.path);

  expect(
    getWindowIdentity(directory.path, {
      source: {
        type: 'pull-request',
        url: 'https://github.com/NKZW-Tech/Codiff/pull/8',
      },
    })?.sourceKey,
  ).toBe('pull-request:nkzw-tech/codiff#8');
  expect(
    getWindowIdentity(directory.path, {
      source: {
        number: 8,
        owner: 'nkzw-tech',
        repo: 'codiff',
        type: 'pull-request',
        url: 'https://github.com/nkzw-tech/codiff/pull/8',
      },
    })?.key,
  ).toBe(
    getWindowIdentity(directory.path, {
      source: {
        type: 'pull-request',
        url: 'https://github.com/NKZW-Tech/Codiff/pull/8',
      },
    })?.key,
  );
});

test('window identities normalize GitLab merge request sources', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-identity-');
  await initRepository(directory.path);

  expect(
    getWindowIdentity(directory.path, {
      source: {
        type: 'pull-request',
        url: 'https://gitlab.example.com/group/subgroup/project/-/merge_requests/8',
      },
    })?.sourceKey,
  ).toBe('pull-request:gitlab:gitlab.example.com/group/subgroup/project#8');
});

test('window identity matching requires exact identity matches', () => {
  expect(
    findMatchingWindowIdentity(
      { key: 'repo-a\0working-tree' },
      new Map([
        [1, { key: 'repo-a\0commit:abc' }],
        [2, { key: 'repo-a\0working-tree' }],
      ]),
    ),
  ).toBe(2);
  expect(
    findMatchingWindowIdentity(
      { key: 'repo-a\0pull-request:nkzw-tech/codiff#9' },
      new Map([[1, { key: 'repo-a\0pull-request:nkzw-tech/codiff#8' }]]),
    ),
  ).toBeNull();
  expect(findMatchingWindowIdentity(null, new Map([[1, { key: 'repo-a\0working-tree' }]]))).toBe(
    null,
  );
});
