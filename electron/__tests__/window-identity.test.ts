import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { findMatchingWindowIdentity, getWindowIdentity, parseGitHubPullRequestUrl } =
  require('../window-identity.cjs') as {
    findMatchingWindowIdentity: (
      identity: { key: string } | null,
      existingIdentities: ReadonlyMap<number, { key: string } | null>,
    ) => number | null;
    getWindowIdentity: (
      repositoryPath: string,
      launchOptions?: {
        source?:
          | { type: 'arc-working-tree' }
          | { base: string; type: 'arc-branch' }
          | { ref: string; type: 'arc-commit' }
          | { number: number; type: 'arc-pull-request' }
          | { base: string; head: string; symmetric: boolean; type: 'arc-range' }
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
    parseGitHubPullRequestUrl: (value: string) => {
      number: number;
      owner: string;
      repo: string;
    } | null;
  };

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) => {
  const result = await execFileAsync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8' },
  );
  return result.stdout.trim();
};

const createRepository = async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'codiff-window-identity-'));
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
  await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
  await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial']);
  return repositoryPath;
};

test.sequential('plan window identities do not invoke Git outside repositories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-plan-window-identity-'));
  const fakeBin = join(directory, 'bin');
  const gitMarker = join(directory, 'git-invoked');
  const planFile = join(directory, 'plan.md');
  const previousPath = process.env.PATH;

  try {
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, 'git'), `#!/bin/sh\nprintf invoked > "${gitMarker}"\nexit 99\n`);
    await chmod(join(fakeBin, 'git'), 0o755);
    await writeFile(planFile, '# Plan\n');
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    const realDirectory = await realpath(directory);
    const realPlanFile = await realpath(planFile);

    expect(
      getWindowIdentity(directory, {
        planFile,
        planResultFile: join(directory, 'result.json'),
      }),
    ).toMatchObject({
      repositoryRoot: realDirectory,
      sourceKey: `plan:${realPlanFile}`,
    });
    expect(await readFile(gitMarker, 'utf8').catch(() => null)).toBeNull();
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { force: true, recursive: true });
  }
});

test.sequential('Arc window identities use Arc roots and source keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-arc-window-identity-'));
  const fakeBin = join(directory, 'bin');
  const workspace = join(directory, 'workspace');
  const previousPath = process.env.PATH;

  try {
    await mkdir(fakeBin);
    await mkdir(workspace);
    await writeFile(
      join(fakeBin, 'arc'),
      '#!/bin/sh\nif [ "$1" = "root" ]; then pwd; exit 0; fi\nexit 1\n',
    );
    await chmod(join(fakeBin, 'arc'), 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    const realWorkspace = await realpath(workspace);

    expect(getWindowIdentity(realWorkspace, { source: { type: 'arc-working-tree' } })).toEqual({
      key: `${realWorkspace}\0arc-working-tree`,
      repositoryRoot: realWorkspace,
      sourceKey: 'arc-working-tree',
    });
    expect(
      getWindowIdentity(realWorkspace, {
        source: { base: 'HEAD~1', head: 'HEAD', symmetric: false, type: 'arc-range' },
      }),
    ).toEqual({
      key: `${realWorkspace}\0arc-range:HEAD~1..HEAD`,
      repositoryRoot: realWorkspace,
      sourceKey: 'arc-range:HEAD~1..HEAD',
    });
    expect(
      getWindowIdentity(realWorkspace, {
        source: { number: 123, type: 'arc-pull-request' },
      }),
    ).toEqual({
      key: `${realWorkspace}\0arc-pull-request:123`,
      repositoryRoot: realWorkspace,
      sourceKey: 'arc-pull-request:123',
    });
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { force: true, recursive: true });
  }
});

test('window identities match working-tree launches inside the same repository', async () => {
  const repositoryPath = await createRepository();

  try {
    const nestedPath = join(repositoryPath, 'src');
    await mkdir(nestedPath);

    expect(getWindowIdentity(nestedPath)?.key).toBe(getWindowIdentity(repositoryPath)?.key);
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('window identities resolve commit refs to the same commit sha', async () => {
  const repositoryPath = await createRepository();

  try {
    const head = await git(repositoryPath, ['rev-parse', 'HEAD']);

    expect(
      getWindowIdentity(repositoryPath, {
        source: { ref: 'HEAD', type: 'commit' },
      })?.sourceKey,
    ).toBe(`commit:${head}`);
    expect(
      getWindowIdentity(repositoryPath, {
        source: { ref: head.slice(0, 8), type: 'commit' },
      })?.key,
    ).toBe(
      getWindowIdentity(repositoryPath, {
        source: { ref: 'HEAD', type: 'commit' },
      })?.key,
    );
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('implicit walkthrough identities use HEAD only when the working tree is clean', async () => {
  const repositoryPath = await createRepository();

  try {
    const headIdentity = getWindowIdentity(repositoryPath, {
      source: { ref: 'HEAD', type: 'commit' },
    });
    expect(getWindowIdentity(repositoryPath, { walkthrough: true })?.key).toBe(headIdentity?.key);

    await writeFile(join(repositoryPath, 'local.txt'), 'change\n');
    expect(getWindowIdentity(repositoryPath, { walkthrough: true })?.sourceKey).toBe(
      'working-tree',
    );

    await rm(join(repositoryPath, 'local.txt'));
    expect(
      getWindowIdentity(repositoryPath, {
        walkthrough: true,
        walkthroughFile: '/tmp/walkthrough.json',
      })?.sourceKey,
    ).toBe('working-tree');
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('window identities distinguish branch history launches', async () => {
  const repositoryPath = await createRepository();

  try {
    await git(repositoryPath, ['checkout', '-b', 'feature']);
    const head = (await git(repositoryPath, ['rev-parse', 'HEAD'])).trim().toLowerCase();

    expect(
      getWindowIdentity(repositoryPath, {
        source: { ref: 'feature', type: 'branch' },
      })?.sourceKey,
    ).toBe(`branch-diff:feature:${head}:${head}`);

    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'feature update']);
    const nextHead = (await git(repositoryPath, ['rev-parse', 'HEAD'])).trim().toLowerCase();

    expect(
      getWindowIdentity(repositoryPath, {
        source: { baseRef: head, headRef: nextHead, ref: 'feature', type: 'branch-diff' },
      })?.sourceKey,
    ).toBe(`branch-diff:feature:${head}:${nextHead}`);
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('window identities normalize GitHub pull request sources', async () => {
  const repositoryPath = await createRepository();

  try {
    expect(
      getWindowIdentity(repositoryPath, {
        source: {
          type: 'pull-request',
          url: 'https://github.com/NKZW-Tech/Codiff/pull/8',
        },
      })?.sourceKey,
    ).toBe('pull-request:nkzw-tech/codiff#8');
    expect(
      getWindowIdentity(repositoryPath, {
        source: {
          number: 8,
          owner: 'nkzw-tech',
          repo: 'codiff',
          type: 'pull-request',
          url: 'https://github.com/nkzw-tech/codiff/pull/8',
        },
      })?.key,
    ).toBe(
      getWindowIdentity(repositoryPath, {
        source: {
          type: 'pull-request',
          url: 'https://github.com/NKZW-Tech/Codiff/pull/8',
        },
      })?.key,
    );
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('window identities normalize GitLab merge request sources', async () => {
  const repositoryPath = await createRepository();

  try {
    expect(
      getWindowIdentity(repositoryPath, {
        source: {
          type: 'pull-request',
          url: 'https://gitlab.example.com/group/subgroup/project/-/merge_requests/8',
        },
      })?.sourceKey,
    ).toBe('pull-request:gitlab:gitlab.example.com/group/subgroup/project#8');
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
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

test('parseGitHubPullRequestUrl rejects non pull request URLs', () => {
  expect(parseGitHubPullRequestUrl('https://github.com/nkzw-tech/codiff/pull/8')).toEqual({
    number: 8,
    owner: 'nkzw-tech',
    repo: 'codiff',
  });
  expect(parseGitHubPullRequestUrl('https://github.com/nkzw-tech/codiff/issues/8')).toBeNull();
});
