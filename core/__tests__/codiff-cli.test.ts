import { execFile } from 'node:child_process';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import { formatHelpText, parseArguments, resolvePullRequestUrl } from '../../bin/arguments.js';
import type { PlanReview } from '../types.ts';
import { createFakeCommandLogger, createFakeOpenLogger } from './helpers/cli.ts';

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8' },
  );
};

let refRepositoryPath = '';
let refRepositoryShortHash = '';

beforeAll(async () => {
  refRepositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'codiff-cli-refs-')));
  await git(refRepositoryPath, ['init']);
  await git(refRepositoryPath, ['config', 'user.email', 'codiff@example.com']);
  await git(refRepositoryPath, ['config', 'user.name', 'Codiff Test']);
  await git(refRepositoryPath, ['commit', '--allow-empty', '-m', 'first']);
  await git(refRepositoryPath, ['branch', 'base']);
  await git(refRepositoryPath, ['commit', '--allow-empty', '-m', 'second']);
  await git(refRepositoryPath, ['branch', 'feature']);
  const { stdout } = await execFileAsync('git', ['-C', refRepositoryPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  refRepositoryShortHash = stdout.trim().slice(0, 8);
  await git(refRepositoryPath, ['branch', refRepositoryShortHash]);
  await git(refRepositoryPath, ['branch', 'target']);
});

afterAll(async () => {
  if (refRepositoryPath) {
    await rm(refRepositoryPath, { force: true, recursive: true });
  }
});

const withCwd = async <T>(cwd: string, callback: () => T | Promise<T>) => {
  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    return await callback();
  } finally {
    process.chdir(previousCwd);
  }
};

test('parseArguments treats a hash positional as a commit ref', () => {
  const commitRef = 'a1b2c3d4e5f678901234567890abcdef12345678';

  expect(parseArguments(['-w', commitRef])).toEqual({
    commitRef,
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: true,
  });
});

test('parseArguments treats HEAD positional revisions as commit refs', () => {
  expect(parseArguments(['HEAD'])).toEqual({
    commitRef: 'HEAD',
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });

  expect(parseArguments(['HEAD^1'])).toEqual({
    commitRef: 'HEAD^1',
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats plain branch refs as branch refs', async () => {
  await withCwd(refRepositoryPath, () => {
    expect(parseArguments(['feature'])).toEqual({
      branchRef: 'feature',
      commitRef: null,
      help: false,
      pullRequestNumber: null,
      pullRequestUrl: null,
      requestedPath: refRepositoryPath,
      version: false,
      walkthrough: false,
    });
  });
});

test('parseArguments treats missing plain refs in Git repositories as branch refs', async () => {
  await withCwd(refRepositoryPath, () => {
    expect(parseArguments(['definitely-missing-branch'])).toMatchObject({
      branchRef: 'definitely-missing-branch',
      commitRef: null,
      requestedPath: refRepositoryPath,
    });

    expect(parseArguments(['definitely-missing-branch', refRepositoryPath])).toMatchObject({
      branchRef: 'definitely-missing-branch',
      commitRef: null,
      requestedPath: refRepositoryPath,
    });
  });
});

test('parseArguments treats hex-like refs as commits before branches', async () => {
  await withCwd(refRepositoryPath, () => {
    expect(parseArguments([refRepositoryShortHash])).toMatchObject({
      commitRef: refRepositoryShortHash,
      requestedPath: refRepositoryPath,
    });

    expect(parseArguments(['--branch', refRepositoryShortHash])).toMatchObject({
      branchRef: refRepositoryShortHash,
      commitRef: null,
      requestedPath: refRepositoryPath,
    });
  });
});

test('parseArguments keeps existing hash-like paths as repository paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-cli-'));
  const repositoryPath = join(directory, 'deadbeef');

  try {
    await mkdir(repositoryPath);

    expect(parseArguments([repositoryPath])).toEqual({
      commitRef: null,
      help: false,
      pullRequestNumber: null,
      pullRequestUrl: null,
      requestedPath: repositoryPath,
      version: false,
      walkthrough: false,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test.sequential('parseArguments does not inspect Git refs for plan working directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-plan-arguments-'));
  const fakeBin = join(directory, 'bin');
  const gitMarker = join(directory, 'git-invoked');
  const planFile = join(directory, 'plan.md');
  const workspace = join(directory, 'workspace');
  const previousPath = process.env.PATH;

  try {
    await mkdir(fakeBin);
    await mkdir(workspace);
    await writeFile(planFile, '# Plan\n');
    await writeFile(join(fakeBin, 'git'), `#!/bin/sh\nprintf invoked > "${gitMarker}"\nexit 99\n`);
    await chmod(join(fakeBin, 'git'), 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    const realWorkspace = await realpath(workspace);

    await withCwd(directory, () => {
      expect(parseArguments(['--plan', planFile, 'workspace'])).toMatchObject({
        commitRef: null,
        planFilePath: planFile,
        requestedPath: realWorkspace,
      });
    });
    expect(await readFile(gitMarker, 'utf8').catch(() => null)).toBeNull();
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { force: true, recursive: true });
  }
});

test('parseArguments treats GitHub pull request URLs as review sources', () => {
  const pullRequestUrl = 'https://github.com/nkzw-tech/codiff/pull/3';

  expect(parseArguments([pullRequestUrl])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: null,
    pullRequestUrl,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats PR number shorthands as review sources', () => {
  expect(parseArguments(['#75'])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: 75,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats PR marker arguments as review sources', () => {
  expect(parseArguments(['pr', '75'])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: 75,
    pullRequestProvider: 'github',
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments recognizes Codex walkthrough seed options', () => {
  expect(
    parseArguments([
      '-w',
      '--codex-session',
      '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
      '--walkthrough-context',
      'seed.json',
    ]),
  ).toEqual({
    codexSessionId: '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
    commitRef: null,
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: true,
    walkthroughContextPath: resolve('seed.json'),
  });
});

test('parseArguments recognizes a pre-authored walkthrough file', () => {
  expect(parseArguments(['-w', '--walkthrough-file', '.codiff/walkthrough.json'])).toMatchObject({
    walkthrough: true,
    walkthroughFilePath: resolve('.codiff/walkthrough.json'),
  });
});

test('parseArguments recognizes a blocking Markdown plan', () => {
  expect(parseArguments(['--plan', 'plan.md'])).toMatchObject({
    planFilePath: resolve('plan.md'),
    requestedPath: resolve(process.cwd()),
    walkthrough: false,
  });
});

test('parseArguments treats --share as a headless walkthrough for the same target syntax', () => {
  expect(parseArguments(['--share', 'HEAD'])).toMatchObject({
    commitRef: 'HEAD',
    requestedPath: resolve(process.cwd()),
    share: true,
    walkthrough: true,
  });
});

test('parseArguments recognizes the walkthrough guide flag', () => {
  expect(parseArguments(['--walkthrough-guide'])).toMatchObject({ walkthroughGuide: true });
  expect(parseArguments([])).not.toHaveProperty('walkthroughGuide');
});

test('parseArguments recognizes Claude walkthrough seed options and the agent override', () => {
  expect(
    parseArguments([
      '-w',
      '--agent',
      'claude',
      '--claude-session',
      '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
    ]),
  ).toMatchObject({
    agentBackend: 'claude',
    claudeSessionId: '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
    walkthrough: true,
  });
});

test('parseArguments recognizes the OpenCode agent override', () => {
  expect(
    parseArguments([
      '-w',
      '--agent',
      'opencode',
      '--opencode-session',
      'ses_121b4816bffebMr9YE52O4870p',
    ]),
  ).toMatchObject({
    agentBackend: 'opencode',
    opencodeSessionId: 'ses_121b4816bffebMr9YE52O4870p',
    walkthrough: true,
  });
});

test('parseArguments ignores unknown agent backends', () => {
  const result = parseArguments(['--agent', 'gpt']) as { agentBackend?: string };
  expect(result.agentBackend).toBeUndefined();
});

test('parseArguments treats hash-prefixed PR marker values as review sources', () => {
  expect(parseArguments(['pr', '#75'])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: 75,
    pullRequestProvider: 'github',
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats GitLab MR marker values as review sources', () => {
  expect(parseArguments(['mr', '23'])).toMatchObject({
    pullRequestNumber: 23,
    pullRequestProvider: 'gitlab',
  });
});

test('parseArguments accepts nested GitLab merge request URLs', () => {
  expect(
    parseArguments(['https://gitlab.example.com/group/subgroup/project/-/merge_requests/23']),
  ).toMatchObject({
    pullRequestUrl: 'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23',
  });
});

test('resolvePullRequestUrl builds GitHub PR URLs from the origin remote', async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'codiff-cli-'));

  try {
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['remote', 'add', 'upstream', 'https://github.com/other/repo.git']);
    await git(repositoryPath, ['remote', 'add', 'origin', 'git@github.com:nkzw-tech/codiff.git']);

    expect(resolvePullRequestUrl(repositoryPath, 75)).toBe(
      'https://github.com/nkzw-tech/codiff/pull/75',
    );
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('resolvePullRequestUrl builds GitLab MR URLs from an arbitrary GitLab remote', async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'codiff-cli-'));

  try {
    await git(repositoryPath, ['init']);
    await git(repositoryPath, [
      'remote',
      'add',
      'origin',
      'git@gitlab.example.com:group/subgroup/project.git',
    ]);

    expect(resolvePullRequestUrl(repositoryPath, 23, 'gitlab')).toBe(
      'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23',
    );
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('packaged terminal helper forwards --commit HEAD to Electron', async () => {
  const logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');

  try {
    await mkdir(repositoryPath);

    await execFileAsync(resolve('bin/codiff-app'), ['--commit', 'HEAD', repositoryPath], {
      env: logger.env,
    });

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--commit',
      'HEAD',
      repositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards GitLab MR markers to Electron', async () => {
  const logger = await createFakeOpenLogger();

  try {
    await execFileAsync(resolve('bin/codiff-app'), ['mr', '23'], {
      env: logger.env,
    });

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      'mr',
      '23',
      process.cwd(),
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards HEAD^1 to Electron as a commit', async () => {
  const logger = await createFakeOpenLogger();

  try {
    await execFileAsync(resolve('bin/codiff-app'), ['HEAD^1'], {
      env: logger.env,
    });

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--commit',
      'HEAD^1',
      process.cwd(),
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards branch names to Electron as branches', async () => {
  const logger = await createFakeOpenLogger();

  try {
    await execFileAsync(resolve('bin/codiff-app'), ['feature'], {
      cwd: refRepositoryPath,
      env: logger.env,
    });

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--branch',
      'feature',
      refRepositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards missing branch names to Electron as branches', async () => {
  const logger = await createFakeOpenLogger();

  try {
    await execFileAsync(resolve('bin/codiff-app'), ['definitely-missing-branch'], {
      cwd: refRepositoryPath,
      env: logger.env,
    });

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--branch',
      'definitely-missing-branch',
      refRepositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards hex refs to Electron as commits', async () => {
  const logger = await createFakeOpenLogger();

  try {
    await execFileAsync(resolve('bin/codiff-app'), [refRepositoryShortHash], {
      cwd: refRepositoryPath,
      env: logger.env,
    });

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--commit',
      refRepositoryShortHash,
      refRepositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards relative repository paths as absolute paths', async () => {
  const logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');

  try {
    await mkdir(join(repositoryPath, 'sub'), { recursive: true });
    const actualRepositoryPath = await realpath(repositoryPath);

    const runHelper = async (args: ReadonlyArray<string>) => {
      await logger.reset();
      await execFileAsync(resolve('bin/codiff-app'), args, {
        cwd: repositoryPath,
        env: logger.env,
      });
      return logger.readArgs();
    };

    expect(await runHelper(['.'])).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      `${actualRepositoryPath}/.`,
    ]);
    expect(await runHelper(['sub'])).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      join(actualRepositoryPath, 'sub'),
    ]);
    expect(await runHelper(['-w', '.'])).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--walkthrough',
      `${actualRepositoryPath}/.`,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards Codex walkthrough seed options', async () => {
  const logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const contextPath = join(logger.directory, 'seed.json');

  try {
    await mkdir(repositoryPath);
    await writeFile(contextPath, '{}');

    await execFileAsync(
      resolve('bin/codiff-app'),
      [
        '-w',
        '--codex-session',
        '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
        '--walkthrough-context',
        contextPath,
        repositoryPath,
      ],
      {
        env: logger.env,
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--codex-session',
      '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
      '--walkthrough-context',
      contextPath,
      '--walkthrough',
      repositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards pre-authored walkthrough files', async () => {
  const logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

  try {
    await mkdir(repositoryPath);
    await writeFile(walkthroughFile, '{}');

    await execFileAsync(
      resolve('bin/codiff-app'),
      [
        '-w',
        '--agent',
        'claude',
        '--walkthrough-file',
        walkthroughFile,
        '--claude-session',
        '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
        repositoryPath,
      ],
      {
        env: logger.env,
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--claude-session',
      '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
      '--agent',
      'claude',
      '--walkthrough-file',
      walkthroughFile,
      '--walkthrough',
      repositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards a plan handoff and result file', async () => {
  const logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const planFile = join(logger.directory, 'plan.md');
  const resultFile = join(logger.directory, 'result.json');

  try {
    await mkdir(repositoryPath);
    await writeFile(planFile, '# Plan\n');
    await writeFile(resultFile, '{"status":"done"}\n');

    const { stdout } = await execFileAsync(
      resolve('bin/codiff-app'),
      ['--plan-file', planFile, '--plan-result-file', resultFile, repositoryPath],
      {
        env: logger.env,
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--plan-file',
      planFile,
      '--plan-result-file',
      resultFile,
      repositoryPath,
    ]);
    expect(stdout).toBe('CODIFF_PLAN_RESULT {"status":"done"}\n');
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper waits for an open plan to finish', async () => {
  const logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const planFile = join(logger.directory, 'plan.md');
  const resultFile = join(logger.directory, 'result.json');
  const openPath = join(logger.directory, 'bin', 'open');

  try {
    await mkdir(repositoryPath);
    await writeFile(planFile, '# Plan\n');
    await writeFile(
      openPath,
      `#!/bin/sh
result_file=""
previous=""
for arg in "$@"; do
  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"
  if [ "$previous" = "--plan-result-file" ]; then
    result_file="$arg"
  fi
  previous="$arg"
done
(
  sleep 0.05
  printf '{"documentChanged":true,"status":"closed"}\\n' > "$result_file"
) &
app_pid=$!
printf '{"pid":%s,"status":"open"}\\n' "$app_pid" > "$result_file"
`,
    );
    await chmod(openPath, 0o755);

    const { stdout } = await execFileAsync(
      resolve('bin/codiff-app'),
      ['--plan-file', planFile, '--plan-result-file', resultFile, repositoryPath],
      {
        env: logger.env,
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--plan-file',
      planFile,
      '--plan-result-file',
      resultFile,
      repositoryPath,
    ]);
    expect(stdout).toBe('CODIFF_PLAN_RESULT {"documentChanged":true,"status":"closed"}\n');
  } finally {
    await logger.cleanup();
  }
});

test('Codex skill launcher uses the session cwd as the repository target', async () => {
  const logger = await createFakeCommandLogger('codiff-skill-launcher-', 'codiff');
  const home = join(logger.directory, 'home');
  const repositoryPath = join(logger.directory, 'repo');
  const sessionDirectory = join(home, '.codex', 'sessions', '2026', '05', '25');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
  const sessionPath = join(sessionDirectory, `rollout-${sessionId}.jsonl`);
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

  try {
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(walkthroughFile, '{}');
    await writeFile(sessionPath, '');
    await truncate(sessionPath, 17 * 1024 * 1024);
    await appendFile(
      sessionPath,
      `\n${JSON.stringify({
        payload: { cwd: repositoryPath },
        type: 'turn_context',
      })}\n`,
    );

    await execFileAsync(
      process.execPath,
      [resolve('codex/skills/codiff/scripts/open-codiff.mjs'), '--file', walkthroughFile, 'HEAD'],
      {
        cwd: resolve('codex/skills/codiff'),
        env: {
          ...logger.env,
          CODEX_HOME: join(home, '.codex'),
          CODEX_THREAD_ID: sessionId,
          CODIFF_COMMAND: logger.commandPath,
        },
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-w',
      '--agent',
      'codex',
      '--walkthrough-file',
      walkthroughFile,
      '--codex-session',
      sessionId,
      'HEAD',
      repositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('Codex skill launcher opens a blocking plan handoff', async () => {
  const logger = await createFakeCommandLogger('codiff-plan-launcher-', 'codiff');
  const repositoryPath = join(logger.directory, 'repo');
  const planFile = join(logger.directory, 'plan.md');

  try {
    await mkdir(repositoryPath, { recursive: true });
    await writeFile(planFile, '# Plan\n');

    await execFileAsync(
      process.execPath,
      [resolve('codex/skills/codiff/scripts/open-codiff.mjs'), '--plan', planFile],
      {
        cwd: resolve('codex/skills/codiff'),
        env: {
          ...logger.env,
          CODEX_SESSION_CWD: repositoryPath,
          CODEX_THREAD_ID: '',
          CODIFF_COMMAND: logger.commandPath,
        },
      },
    );

    expect(await logger.readArgs()).toEqual(['--plan', planFile, '--agent', 'codex']);
  } finally {
    await logger.cleanup();
  }
});

test('Codex skill launcher resolves handled plan comments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-plan-comments-'));
  const reviewPath = join(directory, 'review.json');
  const author = {
    email: 'reviewer@example.com',
    id: 'reviewer@example.com',
    name: 'Reviewer',
  };
  const review = {
    document: {
      id: 'plan:/tmp/plan.md',
      path: '/tmp/plan.md',
      version: 'plan-version',
    },
    threads: ['thread-1', 'thread-2'].map((id) => ({
      anchor: {
        block: {
          fingerprint: `${id}-fingerprint`,
          path: [0],
          text: 'Execute the plan',
          type: 'heading',
        },
        kind: 'block' as const,
        version: 1 as const,
      },
      createdAt: '2026-06-24T00:00:00.000Z',
      createdBy: author,
      id,
      messages: [
        {
          author,
          body: `Handle ${id}.`,
          createdAt: '2026-06-24T00:00:00.000Z',
          id: `${id}-message`,
          updatedAt: '2026-06-24T00:00:00.000Z',
        },
      ],
      status: 'open' as const,
      updatedAt: '2026-06-24T00:00:00.000Z',
    })),
    version: 1 as const,
  } satisfies PlanReview;

  try {
    await writeFile(reviewPath, `${JSON.stringify(review)}\n`);
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        resolve('codex/skills/codiff/scripts/open-codiff.mjs'),
        '--resolve-plan-comments',
        reviewPath,
        'thread-1',
        'missing-thread',
      ],
      { cwd: resolve('codex/skills/codiff') },
    );

    expect(stdout).toBe(
      'CODIFF_PLAN_COMMENTS_RESOLVED {"missingIds":["missing-thread"],"resolvedIds":["thread-1"]}\n',
    );
    const savedReview = JSON.parse(await readFile(reviewPath, 'utf8')) as PlanReview;
    expect(savedReview.threads).toEqual([
      expect.objectContaining({
        id: 'thread-1',
        resolution: expect.objectContaining({
          reason: 'agent-handled',
          resolvedAt: expect.any(String),
        }),
        status: 'resolved',
      }),
      review.threads[1],
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('Codex skill launcher delegates plan shares without opening Electron', async () => {
  const logger = await createFakeCommandLogger('codiff-plan-share-launcher-', 'share-codiff');
  const repositoryPath = join(logger.directory, 'repo');
  const planFile = join(logger.directory, 'plan.md');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';

  try {
    await mkdir(repositoryPath, { recursive: true });
    await writeFile(planFile, '# Plan\n');

    await execFileAsync(
      process.execPath,
      [resolve('codex/skills/codiff/scripts/open-codiff.mjs'), '--plan', planFile, '--share'],
      {
        cwd: resolve('codex/skills/codiff'),
        env: {
          ...logger.env,
          CODEX_SESSION_CWD: repositoryPath,
          CODEX_THREAD_ID: sessionId,
          CODIFF_SHARE_COMMAND: logger.commandPath,
        },
      },
    );

    expect(await logger.readArgs()).toEqual([
      '--plan',
      planFile,
      '--agent',
      'codex',
      '--codex-session',
      sessionId,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('Codex skill launcher falls back to the source repo when run from the skill directory', async () => {
  const logger = await createFakeCommandLogger('codiff-skill-launcher-', 'codiff');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

  try {
    await writeFile(walkthroughFile, '{}');

    await execFileAsync(
      process.execPath,
      [resolve('codex/skills/codiff/scripts/open-codiff.mjs'), '--file', walkthroughFile],
      {
        cwd: resolve('codex/skills/codiff'),
        env: {
          ...logger.env,
          CODEX_HOME: join(logger.directory, 'home', '.codex'),
          CODEX_THREAD_ID: '',
          CODIFF_COMMAND: logger.commandPath,
        },
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-w',
      '--agent',
      'codex',
      '--walkthrough-file',
      walkthroughFile,
      resolve('.'),
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('Codex skill launcher does not override explicit repository targets', async () => {
  const logger = await createFakeCommandLogger('codiff-skill-launcher-', 'codiff');
  const sessionRepositoryPath = join(logger.directory, 'session-repo');
  const explicitRepositoryPath = join(logger.directory, 'explicit-repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

  try {
    await mkdir(sessionRepositoryPath, { recursive: true });
    await mkdir(explicitRepositoryPath, { recursive: true });
    await writeFile(walkthroughFile, '{}');

    await execFileAsync(
      process.execPath,
      [
        resolve('codex/skills/codiff/scripts/open-codiff.mjs'),
        '--file',
        walkthroughFile,
        explicitRepositoryPath,
      ],
      {
        cwd: resolve('codex/skills/codiff'),
        env: {
          ...logger.env,
          CODEX_SESSION_CWD: sessionRepositoryPath,
          CODEX_THREAD_ID: '',
          CODIFF_COMMAND: logger.commandPath,
        },
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-w',
      '--agent',
      'codex',
      '--walkthrough-file',
      walkthroughFile,
      explicitRepositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('Codex skill launcher delegates share requests without opening Electron', async () => {
  const logger = await createFakeCommandLogger('codiff-share-launcher-', 'share-codiff');
  const repositoryPath = join(logger.directory, 'repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

  try {
    await mkdir(repositoryPath, { recursive: true });
    await writeFile(walkthroughFile, '{}');

    await execFileAsync(
      process.execPath,
      [
        resolve('codex/skills/codiff/scripts/open-codiff.mjs'),
        '--share',
        '--open',
        '--file',
        walkthroughFile,
        'HEAD',
      ],
      {
        cwd: resolve('codex/skills/codiff'),
        env: {
          ...logger.env,
          CODEX_SESSION_CWD: repositoryPath,
          CODEX_THREAD_ID: '',
          CODIFF_SHARE_COMMAND: logger.commandPath,
        },
      },
    );

    expect(await logger.readArgs()).toEqual([
      '--file',
      walkthroughFile,
      '--agent',
      'codex',
      '--open',
      'HEAD',
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('Claude skill launcher uses the session cwd and forwards --agent claude', async () => {
  const logger = await createFakeCommandLogger('codiff-claude-launcher-', 'codiff');
  const home = join(logger.directory, 'home');
  const repositoryPath = join(logger.directory, 'repo');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
  const projectDirectory = join(home, '.claude', 'projects', '-tmp-repo');
  const sessionPath = join(projectDirectory, `${sessionId}.jsonl`);
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

  try {
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(walkthroughFile, '{}');
    await writeFile(sessionPath, '');
    await truncate(sessionPath, 17 * 1024 * 1024);
    await appendFile(sessionPath, `\n${JSON.stringify({ cwd: repositoryPath })}\n`);

    await execFileAsync(
      process.execPath,
      [resolve('claude/skills/codiff/scripts/open-codiff.mjs'), '--file', walkthroughFile, 'HEAD'],
      {
        cwd: resolve('claude/skills/codiff'),
        env: {
          ...logger.env,
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CLAUDE_SESSION_ID: sessionId,
          CODIFF_COMMAND: logger.commandPath,
        },
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-w',
      '--agent',
      'claude',
      '--walkthrough-file',
      walkthroughFile,
      '--claude-session',
      sessionId,
      'HEAD',
      repositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('Pi skill launcher resolves the current session and forwards --agent pi', async () => {
  const logger = await createFakeCommandLogger('codiff-pi-launcher-', 'codiff');
  const home = join(logger.directory, 'home');
  const repositoryPath = join(logger.directory, 'repo');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
  const sessionDirectory = join(home, '.pi', 'agent', 'sessions', 'encoded-repo');
  const sessionPath = join(sessionDirectory, `2026-06-10_${sessionId}.jsonl`);
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

  try {
    await mkdir(repositoryPath, { recursive: true });
    const realRepositoryPath = await realpath(repositoryPath);
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(walkthroughFile, '{}');
    await writeFile(
      sessionPath,
      `${JSON.stringify({ cwd: realRepositoryPath, id: sessionId, type: 'session' })}\n`,
    );
    await truncate(sessionPath, 17 * 1024 * 1024);

    await execFileAsync(
      process.execPath,
      [resolve('pi/skills/codiff/scripts/open-codiff.mjs'), '--file', walkthroughFile, 'HEAD'],
      {
        cwd: repositoryPath,
        env: {
          ...logger.env,
          CODIFF_COMMAND: logger.commandPath,
          PI_HOME: join(home, '.pi'),
        },
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-w',
      '--agent',
      'pi',
      '--walkthrough-file',
      walkthroughFile,
      '--pi-session',
      sessionId,
      'HEAD',
      realRepositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('OpenCode skill launcher links the project session from a repository subdirectory', async () => {
  const logger = await createFakeCommandLogger('codiff-opencode-launcher-', 'codiff');
  const repositoryPath = join(logger.directory, 'repo');
  const workingDirectory = join(repositoryPath, 'nested');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');
  const homePath = join(logger.directory, 'home');
  const openCodePath = join(homePath, '.opencode', 'bin', 'opencode');
  const sessionId = 'ses_121b4816bffebMr9YE52O4870p';

  try {
    await mkdir(workingDirectory, { recursive: true });
    await mkdir(join(homePath, '.opencode', 'bin'), { recursive: true });
    const realRepositoryPath = await realpath(repositoryPath);
    const realWorkingDirectory = await realpath(workingDirectory);
    await writeFile(walkthroughFile, '{}');
    await writeFile(
      openCodePath,
      `#!/bin/sh
printf '[{"id":"${sessionId}","directory":"%s"}]\\n' "$OPENCODE_SESSION_DIRECTORY"
`,
    );
    await chmod(openCodePath, 0o755);

    await execFileAsync(
      process.execPath,
      [
        resolve('opencode/skills/codiff/scripts/open-codiff.mjs'),
        '--file',
        walkthroughFile,
        'HEAD',
      ],
      {
        cwd: workingDirectory,
        env: {
          ...logger.env,
          CODIFF_COMMAND: logger.commandPath,
          HOME: homePath,
          OPENCODE_SESSION_DIRECTORY: realRepositoryPath,
          PATH: logger.directory,
        },
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-w',
      '--agent',
      'opencode',
      '--walkthrough-file',
      walkthroughFile,
      '--opencode-session',
      sessionId,
      'HEAD',
      realWorkingDirectory,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards the agent and Claude session to Electron', async () => {
  const logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';

  try {
    await mkdir(repositoryPath);

    await execFileAsync(
      resolve('bin/codiff-app'),
      ['-w', '--agent', 'claude', '--claude-session', sessionId, repositoryPath],
      {
        env: logger.env,
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--claude-session',
      sessionId,
      '--agent',
      'claude',
      '--walkthrough',
      repositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper forwards the OpenCode session to Electron', async () => {
  const logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const sessionId = 'ses_121b4816bffebMr9YE52O4870p';

  try {
    await mkdir(repositoryPath);

    await execFileAsync(
      resolve('bin/codiff-app'),
      ['-w', '--agent', 'opencode', '--opencode-session', sessionId, repositoryPath],
      {
        env: logger.env,
      },
    );

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--opencode-session',
      sessionId,
      '--agent',
      'opencode',
      '--walkthrough',
      repositoryPath,
    ]);
  } finally {
    await logger.cleanup();
  }
});

test('packaged terminal helper runs --share through the bundled Node entry point', async () => {
  const logger = await createFakeCommandLogger('codiff-packaged-share-', 'runtime');

  try {
    await execFileAsync(resolve('bin/codiff-app'), ['--share', 'HEAD'], {
      env: {
        ...logger.env,
        CODIFF_NODE_COMMAND: logger.commandPath,
      },
    });

    expect(await logger.readArgs()).toEqual([resolve('bin/codiff.js'), '--share', 'HEAD']);
  } finally {
    await logger.cleanup();
  }
});

test('parseArguments recognizes --help and -h flags', () => {
  expect(parseArguments(['--help']).help).toBe(true);
  expect(parseArguments(['-h']).help).toBe(true);
});

test('parseArguments recognizes --version and -v flags', () => {
  expect(parseArguments(['--version']).version).toBe(true);
  expect(parseArguments(['-v']).version).toBe(true);
});

test('parseArguments defaults help and version to false', () => {
  const result = parseArguments([]);
  expect(result.help).toBe(false);
  expect(result.version).toBe(false);
});

test('formatHelpText includes version and all flags', () => {
  const text = formatHelpText('1.2.3');
  expect(text).toContain('codiff v1.2.3');
  expect(text).toContain('Usage:');
  expect(text).toContain('--help');
  expect(text).toContain('--version');
  expect(text).toContain('--commit');
  expect(text).toContain('--codex-session');
  expect(text).toContain('--opencode-session');
  expect(text).toContain('--plan');
  expect(text).toContain('--share');
  expect(text).toContain('--walkthrough');
  expect(text).toContain('--walkthrough-context');
  expect(text).toContain('-h');
  expect(text).toContain('-v');
  expect(text).toContain('-w');
  expect(text).toContain('codiff --share');
  expect(text).toContain('codiff --share HEAD');
});

test('formatHelpText styles titles and descriptions', () => {
  const text = formatHelpText('1.2.3');

  expect(text).toContain('\u001b[1;34mUsage:\u001b[0m');
  expect(text).toContain('\u001b[1;34mOptions:\u001b[0m');
  expect(text).toContain('\u001b[1;34mExamples:\u001b[0m');
  expect(text).toContain('  --help, -h');
  expect(text).not.toContain('\u001b[1;34m--help, -h\u001b[0m');
  expect(text).toContain('\u001b[90mShow this help message and exit.\u001b[0m');
  expect(text).toContain('  codiff -w');
  expect(text).not.toContain('\u001b[1;34mcodiff -w\u001b[0m');
  expect(text).toContain('\u001b[90mWalk through local changes, or HEAD when clean.\u001b[0m');
});

test('codiff-app prints help text and exits 0', async () => {
  const { stdout } = await execFileAsync(resolve('bin/codiff-app'), ['--help'], {
    encoding: 'utf8',
  });
  expect(stdout).toContain('codiff v');
  expect(stdout).toContain('Usage:');
  expect(stdout).toContain('--help');
  expect(stdout).toContain('--opencode-session <id>');
  expect(stdout).not.toContain('--agent <codex|claude|opencode|pi>Override');
  expect(stdout).toContain('\u001b[1;34mUsage:\u001b[0m');
  expect(stdout).toContain('\u001b[90mShow this help message and exit.\u001b[0m');
});

test('codiff-app prints version and exits 0', async () => {
  const { stdout } = await execFileAsync(resolve('bin/codiff-app'), ['--version'], {
    encoding: 'utf8',
  });
  expect(stdout).toMatch(/^codiff v\d+\.\d+\.\d+\n$/);
});

test('codiff --walkthrough-guide prints the guide and embedded schema, then exits 0', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['bin/codiff.js', '--walkthrough-guide'],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
    },
  );

  // The authoring prose...
  expect(stdout).toContain('Narrative walkthrough — authoring guide');
  expect(stdout).toContain('chapters');
  expect(stdout).toContain('support');
  // ...followed by the live JSON schema, embedded as a fenced block.
  expect(stdout).toContain('```json');
  expect(stdout).toContain('"chapters"');
  expect(stdout).toContain('"hunkId"');
  expect(stdout).toContain('"const": 4');
});

test('parseArguments reads base...target and base..target as a range', async () => {
  await withCwd(refRepositoryPath, () => {
    expect(parseArguments(['-w', 'base...target'])).toMatchObject({
      range: { base: 'base', head: 'target', symmetric: true },
      requestedPath: refRepositoryPath,
    });
    expect(parseArguments(['base..target'])).toMatchObject({
      range: { base: 'base', head: 'target', symmetric: false },
    });
    // Unresolved refs fall back instead of being silently read as a range.
    expect(parseArguments(['nope...nada']).range).toBeUndefined();
  });
});
