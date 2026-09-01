import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import {
  getAgentReviewOwnerPath,
  readAgentReviewResult,
  waitForAgentReviewResult,
} from '../../bin/agent-review-result.js';
import {
  formatHelpText,
  getReviewSource,
  parseArguments,
  resolvePullRequestTargetUrl,
  resolvePullRequestUrl,
} from '../../bin/arguments.js';
import type { PlanReview } from '../types.ts';
import { createFakeCommandLogger, createFakeOpenLogger } from './helpers/cli.ts';
import { removeGitTestDirectory } from './helpers/git.ts';
import { getGitTestEnvironment } from './helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
  createTemporaryWorkingDirectory,
} from './helpers/resources.ts';

const execFileAsync = promisify(execFile);

const expectAgentReviewDocumentation = (document: string) => {
  const normalized = document.replaceAll(/\s+/g, ' ');
  expect(normalized).toContain('only for agent-launched desktop handoffs');
  expect(normalized).toContain('focused comment draft without requiring blur');
  expect(normalized).toContain('window, comments, and draft stay intact');
  expect(normalized).toContain('disabled when there is no feedback');
  expect(normalized).toContain('status: "closed"');
  expect(normalized).toContain('no actionable feedback');
  expect(normalized).toContain('Successful submission closes Codiff');
  expect(normalized).toContain('same agent turn');
  expect(normalized).toContain('Do not automatically reopen Codiff');
};

const submittedAgentReviewResult = (root: string) => ({
  comments: [
    {
      anchor: 'line',
      body: 'Rename this helper.',
      context: '@@ -1 +1 @@',
      filePath: 'src/app.ts',
      lineNumber: 1,
      order: 1,
      sectionId: 'src/app.ts:unstaged',
      side: 'additions',
    },
  ],
  markdown: '# Address these Review Comments\n',
  repository: { root, source: { type: 'working-tree' } },
  status: 'submitted',
  version: 1,
});

const createAgentReviewCommandLogger = async () => {
  const logger = await createFakeCommandLogger('codiff-agent-review-launcher-', 'codiff');
  const resultPathLog = join(logger.directory, 'result-path.txt');
  await writeFile(
    logger.commandPath,
    `#!/bin/sh
result_file=""
repository_root=""
previous=""
for arg in "$@"; do
  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"
  if [ "$previous" = "--review-result-file" ]; then
    result_file="$arg"
  fi
  if [ -d "$arg" ]; then
    repository_root="$arg"
  fi
  previous="$arg"
done
if [ -n "$repository_root" ]; then
  repository_root="$(git -C "$repository_root" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$repository_root")"
fi
printf '%s' "$result_file" > "$CODIFF_TEST_RESULT_PATH_LOG"
printf '{"version":1,"status":"open","pid":%s,"repository":{"root":"%s","source":{"type":"working-tree"}}}\n' "$$" "$repository_root" > "$result_file.owner"
if [ -n "${'${CODIFF_TEST_CHILD_STDOUT:-}'}" ]; then
  printf '%s\\n' "$CODIFF_TEST_CHILD_STDOUT"
fi
if [ -n "${'${CODIFF_TEST_SIGNAL:-}'}" ]; then
  kill -s "$CODIFF_TEST_SIGNAL" $$
fi
if [ -n "${'${CODIFF_TEST_EXIT_CODE:-}'}" ]; then
  exit "$CODIFF_TEST_EXIT_CODE"
fi
case "${'${CODIFF_TEST_RESULT_MODE:-submitted}'}" in
  submitted)
    if [ -n "${'${CODIFF_TEST_SUBMITTED_RESULT:-}'}" ]; then
      printf '%s\\n' "$CODIFF_TEST_SUBMITTED_RESULT" > "$result_file"
    else
      printf '{"version":1,"status":"submitted","repository":{"root":"%s","source":{"type":"working-tree"}},"comments":[{"anchor":"line","body":"Rename this helper.","context":"@@ -1 +1 @@","filePath":"src/app.ts","lineNumber":1,"order":1,"sectionId":"src/app.ts:unstaged","side":"additions"}],"markdown":"# Review Comments"}\\n' "$repository_root" > "$result_file"
    fi
    ;;
  closed)
    printf '%s\\n' "$CODIFF_TEST_CLOSED_RESULT" > "$result_file"
    ;;
  raw)
    printf '%s' "$CODIFF_TEST_RAW_RESULT" > "$result_file"
    ;;
  none) ;;
esac
`,
  );

  const readRawArgs = logger.readArgs;

  return Object.assign(logger, {
    env: {
      ...logger.env,
      CODIFF_TEST_RESULT_PATH_LOG: resultPathLog,
    },
    readArgs: async () => {
      const args = await readRawArgs();
      const resultFlagIndex = args.indexOf('--review-result-file');
      return resultFlagIndex === -1
        ? args
        : [...args.slice(0, resultFlagIndex), ...args.slice(resultFlagIndex + 2)];
    },
    readRawArgs,
    readResultPath: () => readFile(resultPathLog, 'utf8'),
  });
};

const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironment(),
  });
};

let refRepositoryPath = '';
let refRepositoryShortHash = '';

beforeAll(async () => {
  refRepositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'codiff-cli-refs-')));
  await git(refRepositoryPath, ['init']);
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
    await removeGitTestDirectory(refRepositoryPath);
  }
});

const withCwd = async <T>(cwd: string, callback: () => T | Promise<T>) => {
  using _workingDirectory = createTemporaryWorkingDirectory(cwd);
  return await callback();
};

test('source CLI rejects simultaneous plan and review handoffs', () => {
  expect(() =>
    parseArguments(['--plan', '/tmp/plan.md', '--review-result-file', '/tmp/review-result.json']),
  ).toThrow('cannot be used together');
});

const withFakeGitHubCli = async <T>(
  response: Record<string, unknown>,
  callback: (argsPath: string) => T | Promise<T>,
) => {
  await using directory = await createTemporaryDirectory('codiff-cli-gh-');
  const argsPath = join(directory.path, 'args.txt');
  const commandPath = join(directory.path, 'gh');

  await writeFile(
    commandPath,
    '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$CODIFF_TEST_GH_ARGS"\ndone\nprintf "%s\\n" "$CODIFF_TEST_GH_RESPONSE"\n',
  );
  await chmod(commandPath, 0o755);
  await using _environment = createTemporaryEnvironment({
    CODIFF_TEST_GH_ARGS: argsPath,
    CODIFF_TEST_GH_RESPONSE: JSON.stringify(response),
    PATH: `${directory.path}:${process.env.PATH ?? ''}`,
  });
  return await callback(argsPath);
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

test('parseArguments canonicalizes review URLs copied from a review tab', () => {
  for (const value of [
    'https://github.com/nkzw-tech/codiff/pull/1728/changes#r4821',
    'https://github.com/nkzw-tech/codiff/pull/1728/files',
    'https://www.github.com/nkzw-tech/codiff/pull/1728?diff=split',
    'github.com/nkzw-tech/codiff/pull/1728',
  ]) {
    expect(parseArguments([value])).toMatchObject({
      pullRequestUrl: 'https://github.com/nkzw-tech/codiff/pull/1728',
    });
  }

  for (const value of [
    'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23/diffs#note_991',
    'https://gitlab.example.com/group/subgroup/project/merge_requests/23',
  ]) {
    expect(parseArguments([value])).toMatchObject({
      pullRequestUrl: 'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23',
    });
  }
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

test('shared branch reviews include uncommitted changes', () => {
  expect(
    getReviewSource({
      branchRef: 'main',
      commitRef: null,
      pullRequestProvider: null,
      pullRequestUrl: null,
      range: null,
    }),
  ).toEqual({
    ref: 'main',
    type: 'branch-working-tree',
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
  await using directory = await createTemporaryDirectory('codiff-cli-');
  const repositoryPath = join(directory.path, 'deadbeef');

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
});

test.sequential('parseArguments does not inspect Git refs for plan working directories', async () => {
  await using directory = await createTemporaryDirectory('codiff-plan-arguments-');
  const fakeBin = join(directory.path, 'bin');
  const gitMarker = join(directory.path, 'git-invoked');
  const planFile = join(directory.path, 'plan.md');
  const workspace = join(directory.path, 'workspace');

  await mkdir(fakeBin);
  await mkdir(workspace);
  await writeFile(planFile, '# Plan\n');
  await writeFile(join(fakeBin, 'git'), `#!/bin/sh\nprintf invoked > "${gitMarker}"\nexit 99\n`);
  await chmod(join(fakeBin, 'git'), 0o755);
  await using _environment = createTemporaryEnvironment({
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  });
  const realWorkspace = await realpath(workspace);

  await withCwd(directory.path, () => {
    expect(parseArguments(['--plan', planFile, 'workspace'])).toMatchObject({
      commitRef: null,
      planFilePath: planFile,
      requestedPath: realWorkspace,
    });
  });
  expect(await readFile(gitMarker, 'utf8').catch(() => null)).toBeNull();
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

test('parseArguments treats GitHub PR branch markers as review sources', () => {
  expect(
    parseArguments(['pr', 'iminoso:feat/pr-branch-lookup', '/path/to/repository']),
  ).toMatchObject({
    pullRequestBranch: 'iminoso:feat/pr-branch-lookup',
    pullRequestNumber: null,
    pullRequestProvider: 'github',
    requestedPath: '/path/to/repository',
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
  await using directory = await createTemporaryDirectory('codiff-cli-');
  const repositoryPath = directory.path;

  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['remote', 'add', 'upstream', 'https://github.com/other/repo.git']);
  await git(repositoryPath, ['remote', 'add', 'origin', 'git@github.com:nkzw-tech/codiff.git']);

  expect(resolvePullRequestUrl(repositoryPath, 75)).toBe(
    'https://github.com/nkzw-tech/codiff/pull/75',
  );
});

test('resolvePullRequestUrl builds GitLab MR URLs from an arbitrary GitLab remote', async () => {
  await using directory = await createTemporaryDirectory('codiff-cli-');
  const repositoryPath = directory.path;

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
});

test.sequential('PR branch lookup preserves the canonical GitHub URL returned by gh', async () => {
  await withFakeGitHubCli(
    {
      state: 'OPEN',
      url: 'https://github.com/nkzw-tech/codiff/pull/129',
    },
    async (argsPath) => {
      expect(
        resolvePullRequestTargetUrl({
          branch: 'iminoso:feat/pr-branch-lookup',
          number: null,
          provider: 'github',
          repositoryPath: process.cwd(),
          url: null,
        }),
      ).toBe('https://github.com/nkzw-tech/codiff/pull/129');
      expect(await readFile(argsPath, 'utf8')).toBe(
        ['pr', 'view', 'iminoso:feat/pr-branch-lookup', '--json', 'state,url', ''].join('\n'),
      );
    },
  );
});

test.sequential('PR branch lookup rejects merged pull requests', async () => {
  await withFakeGitHubCli(
    {
      state: 'MERGED',
      url: 'https://github.com/nkzw-tech/codiff/pull/127',
    },
    () => {
      expect(() =>
        resolvePullRequestTargetUrl({
          branch: 'owner:merged-branch',
          number: null,
          provider: 'github',
          repositoryPath: process.cwd(),
          url: null,
        }),
      ).toThrow('Could not find an open GitHub pull request for branch "owner:merged-branch".');
    },
  );
});

test('packaged terminal helper forwards --commit HEAD to Electron', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');

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
});

test('packaged terminal helper forwards agent review handoff result files to Electron', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const resultFile = join(logger.directory, 'review.json');
  const openPath = join(logger.directory, 'bin', 'open');

  await mkdir(repositoryPath);
  await writeFile(
    openPath,
    `#!/bin/sh
for arg in "$@"; do
  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"
done
printf '%s\\n' "$CODIFF_TEST_REVIEW_RESULT" > "$CODIFF_TEST_REVIEW_RESULT_FILE"
sleep 0.1
`,
  );
  await chmod(openPath, 0o755);

  await execFileAsync(
    resolve('bin/codiff-app'),
    ['--review-result-file', resultFile, repositoryPath],
    {
      env: {
        ...logger.env,
        CODIFF_NODE_COMMAND: process.execPath,
        CODIFF_TEST_REVIEW_RESULT: JSON.stringify({
          comments: [],
          markdown: '',
          repository: { root: repositoryPath, source: { type: 'working-tree' } },
          status: 'closed',
          version: 1,
        }),
        CODIFF_TEST_REVIEW_RESULT_FILE: resultFile,
      },
    },
  );

  expect(await logger.readArgs()).toEqual([
    '-W',
    '-n',
    resolve('bin/../../../..'),
    '--args',
    '--review-result-file',
    resultFile,
    repositoryPath,
  ]);
});

test('packaged terminal helper resolves GitHub PR branches to canonical URLs', async () => {
  await using logger = await createFakeOpenLogger();
  const ghArgsPath = join(logger.directory, 'gh-args.txt');
  const ghPath = join(logger.directory, 'bin', 'gh');
  const repositoryPath = join(logger.directory, 'repo');

  await mkdir(repositoryPath);
  await writeFile(
    ghPath,
    '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$GH_ARGS_FILE"\ndone\nprintf "%s\\n" "https://github.com/nkzw-tech/codiff/pull/129"\n',
  );
  await chmod(ghPath, 0o755);

  await execFileAsync(
    resolve('bin/codiff-app'),
    ['pr', 'iminoso:feat/pr-branch-lookup', repositoryPath],
    {
      env: {
        ...logger.env,
        GH_ARGS_FILE: ghArgsPath,
      },
    },
  );

  expect(await readFile(ghArgsPath, 'utf8')).toBe(
    [
      'pr',
      'view',
      'iminoso:feat/pr-branch-lookup',
      '--json',
      'state,url',
      '--jq',
      'select(.state == "OPEN") | .url',
      '',
    ].join('\n'),
  );
  expect(await logger.readArgs()).toEqual([
    '-n',
    resolve('bin/../../../..'),
    '--args',
    'https://github.com/nkzw-tech/codiff/pull/129',
    repositoryPath,
  ]);
});

test('packaged terminal helper forwards GitLab MR markers to Electron', async () => {
  await using logger = await createFakeOpenLogger();

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
});

test('packaged terminal helper forwards review URLs copied from a review tab', async () => {
  for (const value of [
    'https://github.com/nkzw-tech/codiff/pull/1728/changes#r4821',
    'https://github.com/nkzw-tech/codiff/pull/1728/files',
    'https://www.github.com/nkzw-tech/codiff/pull/1728?diff=split',
    'github.com/nkzw-tech/codiff/pull/1728',
    'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23/diffs#note_991',
    'https://gitlab.example.com/group/subgroup/project/merge_requests/23',
  ]) {
    await using logger = await createFakeOpenLogger();

    await execFileAsync(resolve('bin/codiff-app'), [value], {
      env: logger.env,
    });

    expect(await logger.readArgs()).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      value,
      process.cwd(),
    ]);
  }
});

test('packaged terminal helper forwards HEAD^1 to Electron as a commit', async () => {
  await using logger = await createFakeOpenLogger();

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
});

test('packaged terminal helper forwards branch names to Electron as branches', async () => {
  await using logger = await createFakeOpenLogger();

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
});

test('packaged terminal helper forwards missing branch names to Electron as branches', async () => {
  await using logger = await createFakeOpenLogger();

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
});

test('packaged terminal helper forwards hex refs to Electron as commits', async () => {
  await using logger = await createFakeOpenLogger();

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
});

test('packaged terminal helper forwards relative repository paths as absolute paths', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');

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
});

test('packaged terminal helper forwards Codex walkthrough seed options', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const contextPath = join(logger.directory, 'seed.json');

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
});

test('packaged terminal helper forwards pre-authored walkthrough files', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

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
});

test('packaged terminal helper forwards a plan handoff and result file', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const planFile = join(logger.directory, 'plan.md');
  const resultFile = join(logger.directory, 'result.json');

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
});

test('packaged terminal helper rejects simultaneous plan and review handoffs before opening', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const planFile = join(logger.directory, 'plan.md');
  await mkdir(repositoryPath);
  await writeFile(planFile, '# Plan\n');

  await expect(
    execFileAsync(
      resolve('bin/codiff-app'),
      [
        '--plan-file',
        planFile,
        '--review-result-file',
        join(logger.directory, 'review.json'),
        repositoryPath,
      ],
      { env: logger.env },
    ),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('cannot be used together') });
  await expect(logger.readArgs()).rejects.toThrow();
});

test('packaged terminal helper waits for an open plan to finish', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const planFile = join(logger.directory, 'plan.md');
  const resultFile = join(logger.directory, 'result.json');
  const openPath = join(logger.directory, 'bin', 'open');

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
});

test('packaged terminal helper waits for an explicit agent review result', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const resultFile = join(logger.directory, 'review-result.json');
  const openPath = join(logger.directory, 'bin', 'open');
  const reviewResult = submittedAgentReviewResult(repositoryPath);
  await mkdir(repositoryPath);
  await writeFile(
    openPath,
    `#!/bin/sh
wait_for_app=0
for arg in "$@"; do
  if [ "$arg" = "-W" ]; then
    wait_for_app=1
  fi
done
(
  sleep 0.1
  printf '%s\\n' "$CODIFF_TEST_REVIEW_RESULT" > "$CODIFF_TEST_REVIEW_RESULT_FILE"
) </dev/null >/dev/null 2>&1 &
app_pid=$!
if [ "$wait_for_app" -eq 1 ]; then
  wait "$app_pid"
fi
`,
  );
  await chmod(openPath, 0o755);

  const { stdout } = await execFileAsync(
    resolve('bin/codiff-app'),
    ['-w', '--review-result-file', resultFile, repositoryPath],
    {
      env: {
        ...logger.env,
        CODIFF_NODE_COMMAND: process.execPath,
        CODIFF_TEST_REVIEW_RESULT: JSON.stringify(reviewResult),
        CODIFF_TEST_REVIEW_RESULT_FILE: resultFile,
      },
    },
  );

  expect(JSON.parse(await readFile(resultFile, 'utf8'))).toEqual(reviewResult);
  expect(stdout).toBe('');
});

test('packaged terminal helper follows the primary owner after forwarding exits', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const resultFile = join(logger.directory, 'review-result.json');
  const ownerFile = getAgentReviewOwnerPath(resultFile);
  const openPath = join(logger.directory, 'bin', 'open');
  const reviewResult = submittedAgentReviewResult(repositoryPath);
  await mkdir(repositoryPath);
  await writeFile(
    openPath,
    `#!/bin/sh
(
  sleep 0.1
  printf '%s\n' "$CODIFF_TEST_REVIEW_RESULT" > "$CODIFF_TEST_REVIEW_RESULT_FILE"
) </dev/null >/dev/null 2>&1 &
owner_pid=$!
printf '{"version":1,"status":"open","pid":%s,"repository":{"root":"%s","source":{"type":"working-tree"}}}\n' "$owner_pid" "$CODIFF_TEST_REPOSITORY" > "$CODIFF_TEST_OWNER_FILE"
exit 0
`,
  );
  await chmod(openPath, 0o755);

  await execFileAsync(
    resolve('bin/codiff-app'),
    ['-w', '--review-result-file', resultFile, repositoryPath],
    {
      env: {
        ...logger.env,
        CODIFF_NODE_COMMAND: process.execPath,
        CODIFF_TEST_OWNER_FILE: ownerFile,
        CODIFF_TEST_REPOSITORY: repositoryPath,
        CODIFF_TEST_REVIEW_RESULT: JSON.stringify(reviewResult),
        CODIFF_TEST_REVIEW_RESULT_FILE: resultFile,
      },
    },
  );

  expect(JSON.parse(await readFile(resultFile, 'utf8'))).toEqual(reviewResult);
});

test('waiter performs one final result read after owner death', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-final-read-');
  const resultFile = join(directory.path, 'result.json');
  const result = submittedAgentReviewResult(directory.path);
  await writeFile(
    getAgentReviewOwnerPath(resultFile),
    `${JSON.stringify({
      pid: 42,
      repository: result.repository,
      status: 'open',
      version: 1,
    })}\n`,
  );
  let checked = false;

  await expect(
    waitForAgentReviewResult(resultFile, null, {
      isRunning: () => {
        if (!checked) {
          checked = true;
          writeFileSync(resultFile, `${JSON.stringify(result)}\n`);
        }
        return false;
      },
      pollIntervalMs: 1,
    }),
  ).resolves.toEqual(result);
});

test('source CLI waiter treats successful forwarding exit as nonterminal', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-forwarding-');
  const resultFile = join(directory.path, 'result.json');
  const result = submittedAgentReviewResult(directory.path);
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const waiting = waitForAgentReviewResult(resultFile, child, {
    isRunning: () => true,
    openTimeoutMs: 100,
    pollIntervalMs: 1,
  });

  child.emit('exit', 0, null);
  await writeFile(
    getAgentReviewOwnerPath(resultFile),
    `${JSON.stringify({
      pid: 42,
      repository: result.repository,
      status: 'open',
      version: 1,
    })}\n`,
  );
  await writeFile(resultFile, `${JSON.stringify(result)}\n`);

  await expect(waiting).resolves.toEqual(result);
});

test('packaged waiter measures owner publication grace from forwarding exit', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-forwarding-owner-');
  const resultFile = join(directory.path, 'result.json');
  const result = submittedAgentReviewResult(directory.path);
  let currentTime = 0;
  const waiting = waitForAgentReviewResult(resultFile, null, {
    isRunning: (pid) => pid !== 7 || currentTime < 900,
    now: () => currentTime,
    openTimeoutMs: 2000,
    pollIntervalMs: 100,
    processId: 7,
    wait: async () => {
      currentTime += 100;
      if (currentTime === 1500) {
        writeFileSync(
          getAgentReviewOwnerPath(resultFile),
          `${JSON.stringify({
            pid: 42,
            repository: result.repository,
            status: 'open',
            version: 1,
          })}\n`,
        );
        writeFileSync(resultFile, `${JSON.stringify(result)}\n`);
      }
    },
  });

  await expect(waiting).resolves.toEqual(result);
});

test('waiter reports a final malformed result after owner death', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-final-error-');
  const resultFile = join(directory.path, 'result.json');
  await writeFile(resultFile, '{');
  await writeFile(
    getAgentReviewOwnerPath(resultFile),
    `${JSON.stringify({
      pid: 42,
      repository: { root: directory.path, source: { type: 'working-tree' } },
      status: 'open',
      version: 1,
    })}\n`,
  );

  await expect(
    waitForAgentReviewResult(resultFile, null, {
      isRunning: () => false,
      pollIntervalMs: 1,
    }),
  ).rejects.toThrow(/JSON|Unexpected|position/i);
});

test.each([
  [
    { ref: 'abc123', type: 'commit' },
    { ref: 'abc123', type: 'commit' },
  ],
  [
    {
      base: 'main',
      baseSha: 'base-sha',
      head: 'feature',
      headSha: 'head-sha',
      symmetric: true,
      type: 'range',
    },
    {
      base: 'main',
      baseSha: 'base-sha',
      head: 'feature',
      headSha: 'head-sha',
      symmetric: true,
      type: 'range',
    },
  ],
  [
    { baseRef: 'base-sha', headRef: 'head-sha', ref: 'main', type: 'branch-diff' },
    { baseRef: 'base-sha', headRef: 'head-sha', ref: 'main', type: 'branch-diff' },
  ],
  [
    {
      headSha: 'github-head',
      host: 'github.com',
      number: 12,
      owner: 'owner',
      projectPath: 'owner/repo',
      provider: 'github',
      repo: 'repo',
      type: 'pull-request',
      url: 'https://github.com/owner/repo/pull/12',
    },
    {
      headSha: 'github-head',
      host: 'github.com',
      number: 12,
      owner: 'owner',
      projectPath: 'owner/repo',
      provider: 'github',
      repo: 'repo',
      type: 'pull-request',
      url: 'https://github.com/owner/repo/pull/12',
    },
  ],
  [
    {
      headSha: 'gitlab-head',
      host: 'gitlab.example.com',
      number: 23,
      projectPath: 'group/project',
      provider: 'gitlab',
      type: 'pull-request',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
    },
    {
      headSha: 'gitlab-head',
      host: 'gitlab.example.com',
      number: 23,
      projectPath: 'group/project',
      provider: 'gitlab',
      type: 'pull-request',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
    },
  ],
])(
  'launcher preserves and validates canonical source identity %#',
  async (source, expectedSource) => {
    await using directory = await createTemporaryDirectory('codiff-review-source-');
    const resultFile = join(directory.path, 'result.json');
    const result = {
      ...submittedAgentReviewResult(directory.path),
      repository: { root: directory.path, source },
    };
    await writeFile(resultFile, `${JSON.stringify(result)}\n`);

    expect(readAgentReviewResult(resultFile, directory.path, expectedSource)).toMatchObject({
      repository: { source: expectedSource },
    });
    const mismatchedSource =
      expectedSource.type === 'commit'
        ? { ...expectedSource, ref: 'different' }
        : expectedSource.type === 'range'
          ? { ...expectedSource, headSha: 'different' }
          : expectedSource.type === 'branch-diff'
            ? { ...expectedSource, headRef: 'different' }
            : { ...expectedSource, headSha: 'different' };
    expect(() => readAgentReviewResult(resultFile, directory.path, mismatchedSource)).toThrow(
      'source',
    );
  },
);

test.each([
  [1, 1],
  [1, 3],
  [2, 1],
])('launcher rejects noncontiguous comment orders %s,%s', async (firstOrder, secondOrder) => {
  await using directory = await createTemporaryDirectory('codiff-review-orders-');
  const resultFile = join(directory.path, 'result.json');
  const result = submittedAgentReviewResult(directory.path);
  await writeFile(
    resultFile,
    `${JSON.stringify({
      ...result,
      comments: [
        { ...result.comments[0], order: firstOrder },
        { ...result.comments[0], order: secondOrder },
      ],
    })}\n`,
  );

  expect(() => readAgentReviewResult(resultFile, directory.path, result.repository.source)).toThrow(
    'order',
  );
});

test('packaged terminal helper fails when Codiff exits without an agent review result', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const resultFile = join(logger.directory, 'review-result.json');
  await mkdir(repositoryPath);

  await expect(
    execFileAsync(
      resolve('bin/codiff-app'),
      ['-w', '--review-result-file', resultFile, repositoryPath],
      {
        env: {
          ...logger.env,
          CODIFF_NODE_COMMAND: process.execPath,
        },
      },
    ),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('without a review result') });
});

const agentLaunchers = [
  {
    agent: 'codex',
    environment: (repositoryPath: string, sessionId: string) => ({
      CODEX_SESSION_CWD: repositoryPath,
      CODEX_THREAD_ID: sessionId,
    }),
    path: 'codex/skills/codiff/scripts/open-codiff.mjs',
    sessionFlag: '--codex-session',
    sessionId: '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
  },
  {
    agent: 'claude',
    environment: (repositoryPath: string, sessionId: string) => ({
      CLAUDE_SESSION_CWD: repositoryPath,
      CLAUDE_SESSION_ID: sessionId,
    }),
    path: 'claude/skills/codiff/scripts/open-codiff.mjs',
    sessionFlag: '--claude-session',
    sessionId: '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
  },
  {
    agent: 'opencode',
    environment: (_repositoryPath: string, sessionId: string) => ({
      OPENCODE_SESSION_ID: sessionId,
    }),
    path: 'opencode/skills/codiff/scripts/open-codiff.mjs',
    sessionFlag: '--opencode-session',
    sessionId: 'ses_121b4816bffebMr9YE52O4870p',
  },
  {
    agent: 'pi',
    environment: (_repositoryPath: string, sessionId: string) => ({
      PI_SESSION_ID: sessionId,
    }),
    path: 'pi/skills/codiff/scripts/open-codiff.mjs',
    sessionFlag: '--pi-session',
    sessionId: '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
  },
] as const;

test.each(agentLaunchers)(
  '$agent skill launcher canonicalizes a nested repository and isolates child stdout',
  async ({ agent, environment, path, sessionFlag, sessionId }) => {
    await using logger = await createAgentReviewCommandLogger();
    const repositoryPath = join(logger.directory, 'repo');
    const nestedRepositoryPath = join(repositoryPath, 'nested');
    const walkthroughFile = join(logger.directory, 'walkthrough.json');
    await mkdir(nestedRepositoryPath, { recursive: true });
    await git(repositoryPath, ['init']);
    await writeFile(walkthroughFile, '{}');
    const expectedRepositoryPath = await realpath(repositoryPath);
    const expectedNestedRepositoryPath = await realpath(nestedRepositoryPath);
    const reviewResult = submittedAgentReviewResult(expectedRepositoryPath);

    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve(path), '--file', walkthroughFile, expectedNestedRepositoryPath],
      {
        cwd: expectedNestedRepositoryPath,
        env: {
          ...logger.env,
          ...environment(expectedNestedRepositoryPath, sessionId),
          CODIFF_COMMAND: logger.commandPath,
          CODIFF_TEST_CHILD_STDOUT: 'child protocol noise',
          CODIFF_TEST_SUBMITTED_RESULT: JSON.stringify(reviewResult),
        },
      },
    );

    const args = await logger.readRawArgs();
    const resultFlagIndex = args.indexOf('--review-result-file');
    expect(args).toEqual(
      expect.arrayContaining([
        '-w',
        '--agent',
        agent,
        '--walkthrough-file',
        walkthroughFile,
        sessionFlag,
        sessionId,
        expectedNestedRepositoryPath,
      ]),
    );
    expect(resultFlagIndex).toBeGreaterThan(-1);
    expect(args[resultFlagIndex + 1]).toBeTruthy();
    expect(stdout).toBe(`CODIFF_REVIEW_RESULT ${JSON.stringify(reviewResult)}\n`);
    await expect(access(dirname(await logger.readResultPath()))).rejects.toThrow();
  },
);

test.each(agentLaunchers)(
  '$agent skill launcher drains a result larger than the stdout pipe buffer',
  async ({ environment, path, sessionId }) => {
    await using logger = await createAgentReviewCommandLogger();
    const repositoryPath = join(logger.directory, 'repo');
    const walkthroughFile = join(logger.directory, 'walkthrough.json');
    await mkdir(repositoryPath);
    await writeFile(walkthroughFile, '{}');
    const reviewResult = {
      ...submittedAgentReviewResult(await realpath(repositoryPath)),
      markdown: 'x'.repeat(256 * 1024),
    };

    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve(path), '--file', walkthroughFile],
      {
        cwd: repositoryPath,
        env: {
          ...logger.env,
          ...environment(repositoryPath, sessionId),
          CODIFF_COMMAND: logger.commandPath,
          CODIFF_TEST_SUBMITTED_RESULT: JSON.stringify(reviewResult),
        },
        maxBuffer: 1024 * 1024,
      },
    );

    expect(stdout).toBe(`CODIFF_REVIEW_RESULT ${JSON.stringify(reviewResult)}\n`);
    expect(stdout.split('\n')).toHaveLength(2);
  },
);

test('skill launcher returns a closed review result', async () => {
  await using logger = await createAgentReviewCommandLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');
  await mkdir(repositoryPath);
  await writeFile(walkthroughFile, '{}');
  const reviewResult = {
    comments: [],
    markdown: '',
    repository: { root: repositoryPath, source: { type: 'working-tree' } },
    status: 'closed',
    version: 1,
  };
  const normalizedReviewResult = {
    ...reviewResult,
    repository: { ...reviewResult.repository, root: await realpath(repositoryPath) },
  };

  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve(agentLaunchers[0].path), '--file', walkthroughFile],
    {
      cwd: repositoryPath,
      env: {
        ...logger.env,
        ...agentLaunchers[0].environment(repositoryPath, agentLaunchers[0].sessionId),
        CODIFF_COMMAND: logger.commandPath,
        CODIFF_TEST_CLOSED_RESULT: JSON.stringify(reviewResult),
        CODIFF_TEST_RESULT_MODE: 'closed',
      },
    },
  );

  expect(stdout).toBe(`CODIFF_REVIEW_RESULT ${JSON.stringify(normalizedReviewResult)}\n`);
  await expect(access(dirname(await logger.readResultPath()))).rejects.toThrow();
});

test.each([
  ['malformed JSON', '{'],
  ['unsupported version', JSON.stringify({ ...submittedAgentReviewResult('/repo'), version: 2 })],
  [
    'malformed repository source',
    JSON.stringify({
      ...submittedAgentReviewResult('/repo'),
      repository: { root: '/repo', source: { ref: '', type: 'commit' } },
    }),
  ],
  [
    'malformed comment order',
    JSON.stringify({
      ...submittedAgentReviewResult('/repo'),
      comments: [{ ...submittedAgentReviewResult('/repo').comments[0], order: 0 }],
    }),
  ],
  [
    'malformed file anchor',
    JSON.stringify({
      ...submittedAgentReviewResult('/repo'),
      comments: [{ ...submittedAgentReviewResult('/repo').comments[0], anchor: 'file' }],
    }),
  ],
  [
    'malformed comment side',
    JSON.stringify({
      ...submittedAgentReviewResult('/repo'),
      comments: [{ ...submittedAgentReviewResult('/repo').comments[0], side: 'context' }],
    }),
  ],
  [
    'mismatched repository root',
    JSON.stringify(submittedAgentReviewResult('/different-repository')),
  ],
  [
    'empty submitted feedback',
    JSON.stringify({ ...submittedAgentReviewResult('/repo'), comments: [], markdown: '' }),
  ],
  [
    'non-empty closed feedback',
    JSON.stringify({ ...submittedAgentReviewResult('/repo'), status: 'closed' }),
  ],
])('skill launcher rejects %s and cleans up its result file', async (_label, content) => {
  await using logger = await createAgentReviewCommandLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');
  await mkdir(repositoryPath);
  await writeFile(walkthroughFile, '{}');
  const resolvedContent = content.replaceAll('/repo', repositoryPath);

  await expect(
    execFileAsync(process.execPath, [resolve(agentLaunchers[0].path), '--file', walkthroughFile], {
      cwd: repositoryPath,
      env: {
        ...logger.env,
        ...agentLaunchers[0].environment(repositoryPath, agentLaunchers[0].sessionId),
        CODIFF_COMMAND: logger.commandPath,
        CODIFF_TEST_RAW_RESULT: resolvedContent,
        CODIFF_TEST_RESULT_MODE: 'raw',
      },
    }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.any(String) });
  await expect(access(dirname(await logger.readResultPath()))).rejects.toThrow();
});

test('skill launcher emits normalized review data', async () => {
  await using logger = await createAgentReviewCommandLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');
  await mkdir(repositoryPath);
  await writeFile(walkthroughFile, '{}');
  const reviewResult = submittedAgentReviewResult(repositoryPath);
  const normalizedReviewResult = submittedAgentReviewResult(await realpath(repositoryPath));
  const rawResult = {
    ...reviewResult,
    comments: reviewResult.comments.map((comment) => ({ ...comment, ignored: true })),
    ignored: true,
    repository: {
      ...reviewResult.repository,
      source: { ...reviewResult.repository.source, ignored: true },
    },
  };

  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve(agentLaunchers[0].path), '--file', walkthroughFile],
    {
      cwd: repositoryPath,
      env: {
        ...logger.env,
        ...agentLaunchers[0].environment(repositoryPath, agentLaunchers[0].sessionId),
        CODIFF_COMMAND: logger.commandPath,
        CODIFF_TEST_RAW_RESULT: JSON.stringify(rawResult),
        CODIFF_TEST_RESULT_MODE: 'raw',
      },
    },
  );

  expect(stdout).toBe(`CODIFF_REVIEW_RESULT ${JSON.stringify(normalizedReviewResult)}\n`);
});

test.each(agentLaunchers)(
  '$agent skill launcher reports a silent nonzero exit and cleans up',
  async ({ environment, path, sessionId }) => {
    await using logger = await createAgentReviewCommandLogger();
    const repositoryPath = join(logger.directory, 'repo');
    const walkthroughFile = join(logger.directory, 'walkthrough.json');
    await mkdir(repositoryPath);
    await writeFile(walkthroughFile, '{}');

    await expect(
      execFileAsync(process.execPath, [resolve(path), '--file', walkthroughFile], {
        cwd: repositoryPath,
        env: {
          ...logger.env,
          ...environment(repositoryPath, sessionId),
          CODIFF_COMMAND: logger.commandPath,
          CODIFF_TEST_EXIT_CODE: '7',
        },
      }),
    ).rejects.toMatchObject({
      code: 7,
      stderr: expect.stringContaining('Codiff exited with code 7'),
      stdout: '',
    });
    await expect(access(dirname(await logger.readResultPath()))).rejects.toThrow();
  },
);

test.each(agentLaunchers)(
  '$agent skill launcher reports signal termination and cleans up',
  async ({ environment, path, sessionId }) => {
    await using logger = await createAgentReviewCommandLogger();
    const repositoryPath = join(logger.directory, 'repo');
    const walkthroughFile = join(logger.directory, 'walkthrough.json');
    await mkdir(repositoryPath);
    await writeFile(walkthroughFile, '{}');

    await expect(
      execFileAsync(process.execPath, [resolve(path), '--file', walkthroughFile], {
        cwd: repositoryPath,
        env: {
          ...logger.env,
          ...environment(repositoryPath, sessionId),
          CODIFF_COMMAND: logger.commandPath,
          CODIFF_TEST_SIGNAL: 'TERM',
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Codiff terminated by signal SIGTERM'),
      stdout: '',
    });
    await expect(access(dirname(await logger.readResultPath()))).rejects.toThrow();
  },
);

test.each(agentLaunchers)(
  '$agent skill launcher reports spawn failures without leaking result state',
  async ({ environment, path, sessionId }) => {
    await using logger = await createAgentReviewCommandLogger();
    const repositoryPath = join(logger.directory, 'repo');
    const walkthroughFile = join(logger.directory, 'walkthrough.json');
    await mkdir(repositoryPath);
    await writeFile(walkthroughFile, '{}');
    const temporaryResultsBefore = new Set(
      (await readdir(tmpdir())).filter((entry) => entry.startsWith('codiff-review-result-')),
    );

    await expect(
      execFileAsync(process.execPath, [resolve(path), '--file', walkthroughFile], {
        cwd: repositoryPath,
        env: {
          ...logger.env,
          ...environment(repositoryPath, sessionId),
          CODIFF_COMMAND: join(logger.directory, 'missing-codiff'),
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Could not launch Codiff'),
      stdout: '',
    });
    const temporaryResultsAfter = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith('codiff-review-result-'),
    );
    expect(temporaryResultsAfter.filter((entry) => !temporaryResultsBefore.has(entry))).toEqual([]);
  },
);

test('skill launcher rejects a missing result file and cleans up its directory', async () => {
  await using logger = await createAgentReviewCommandLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');
  await mkdir(repositoryPath);
  await writeFile(walkthroughFile, '{}');

  await expect(
    execFileAsync(process.execPath, [resolve(agentLaunchers[0].path), '--file', walkthroughFile], {
      cwd: repositoryPath,
      env: {
        ...logger.env,
        ...agentLaunchers[0].environment(repositoryPath, agentLaunchers[0].sessionId),
        CODIFF_COMMAND: logger.commandPath,
        CODIFF_TEST_RESULT_MODE: 'none',
      },
    }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.any(String) });
  await expect(access(dirname(await logger.readResultPath()))).rejects.toThrow();
});

test('Codex skill launcher uses the session cwd as the repository target', async () => {
  await using logger = await createAgentReviewCommandLogger();
  const home = join(logger.directory, 'home');
  const repositoryPath = join(logger.directory, 'repo');
  const sessionDirectory = join(home, '.codex', 'sessions', '2026', '05', '25');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
  const sessionPath = join(sessionDirectory, `rollout-${sessionId}.jsonl`);
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

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
});

test('Codex skill launcher opens a blocking plan handoff', async () => {
  await using logger = await createFakeCommandLogger('codiff-plan-launcher-', 'codiff');
  const repositoryPath = join(logger.directory, 'repo');
  const planFile = join(logger.directory, 'plan.md');

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
});

test('Codex skill launcher resolves handled plan comments', async () => {
  await using directory = await createTemporaryDirectory('codiff-plan-comments-');
  const reviewPath = join(directory.path, 'review.json');
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
});

test('Codex skill launcher delegates plan shares without opening Electron', async () => {
  await using logger = await createFakeCommandLogger('codiff-plan-share-launcher-', 'share-codiff');
  const repositoryPath = join(logger.directory, 'repo');
  const planFile = join(logger.directory, 'plan.md');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';

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
});

test('Codex skill launcher falls back to the source repo when run from the skill directory', async () => {
  await using logger = await createAgentReviewCommandLogger();
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

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
});

test('Codex skill launcher does not override explicit repository targets', async () => {
  await using logger = await createAgentReviewCommandLogger();
  const sessionRepositoryPath = join(logger.directory, 'session-repo');
  const explicitRepositoryPath = join(logger.directory, 'explicit-repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

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
});

test('Codex skill launcher delegates share requests without opening Electron', async () => {
  await using logger = await createFakeCommandLogger('codiff-share-launcher-', 'share-codiff');
  const repositoryPath = join(logger.directory, 'repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

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
});

test('Claude skill launcher uses the session cwd and forwards --agent claude', async () => {
  await using logger = await createAgentReviewCommandLogger();
  const home = join(logger.directory, 'home');
  const repositoryPath = join(logger.directory, 'repo');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
  const projectDirectory = join(home, '.claude', 'projects', '-tmp-repo');
  const sessionPath = join(projectDirectory, `${sessionId}.jsonl`);
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

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
});

test('Pi skill launcher resolves the current session and forwards --agent pi', async () => {
  await using logger = await createAgentReviewCommandLogger();
  const home = join(logger.directory, 'home');
  const repositoryPath = join(logger.directory, 'repo');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
  const sessionDirectory = join(home, '.pi', 'agent', 'sessions', 'encoded-repo');
  const sessionPath = join(sessionDirectory, `2026-06-10_${sessionId}.jsonl`);
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

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
});

test('OpenCode skill launcher links the project session from a repository subdirectory', async () => {
  await using logger = await createAgentReviewCommandLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const workingDirectory = join(repositoryPath, 'nested');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');
  const homePath = join(logger.directory, 'home');
  const openCodePath = join(homePath, '.opencode', 'bin', 'opencode');
  const sessionId = 'ses_121b4816bffebMr9YE52O4870p';

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
    [resolve('opencode/skills/codiff/scripts/open-codiff.mjs'), '--file', walkthroughFile, 'HEAD'],
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
});

test('packaged terminal helper forwards the agent and Claude session to Electron', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';

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
});

test('packaged terminal helper forwards the OpenCode session to Electron', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  const sessionId = 'ses_121b4816bffebMr9YE52O4870p';

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
});

test('packaged terminal helper runs --share through the bundled Node entry point', async () => {
  await using logger = await createFakeCommandLogger('codiff-packaged-share-', 'runtime');

  await execFileAsync(resolve('bin/codiff-app'), ['--share', 'HEAD'], {
    env: {
      ...logger.env,
      CODIFF_NODE_COMMAND: logger.commandPath,
    },
  });

  expect(await logger.readArgs()).toEqual([resolve('bin/codiff.js'), '--share', 'HEAD']);
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
  expect(text).not.toContain('--review-result-file');
  expect(text).toContain('--share');
  expect(text).toContain('--walkthrough');
  expect(text).toContain('--walkthrough-context');
  expect(text).toContain('-h');
  expect(text).toContain('-v');
  expect(text).toContain('-w');
  expect(text).toContain('codiff --share');
  expect(text).toContain('codiff --share HEAD');
  expect(text).toContain('codiff pr owner:feature');
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
  expect(stdout).toContain('CODIFF_REVIEW_RESULT');
  expect(stdout).toContain('status: "submitted"');
  expect(stdout).toContain('status: "closed"');
  expect(stdout).toContain('Address every returned comment');
  expect(stdout).toContain('Do not automatically reopen Codiff');
  const agentReviewSection = stdout.match(/## Agent Review Handoff[\s\S]*?(?=\n## )/)?.[0];
  expect(agentReviewSection).toBeDefined();
  expectAgentReviewDocumentation(agentReviewSection!);
  // ...followed by the live JSON schema, embedded as a fenced block.
  expect(stdout).toContain('```json');
  expect(stdout).toContain('"chapters"');
  expect(stdout).toContain('"hunkId"');
  expect(stdout).toContain('"const": 4');
});

test('README documents the complete agent review lifecycle in its integration section', async () => {
  const readme = await readFile(resolve('README.md'), 'utf8');
  const agentIntegrationSection = readme.match(/### Agent Integration[\s\S]*?(?=\n## )/)?.[0];

  expect(agentIntegrationSection).toBeDefined();
  expectAgentReviewDocumentation(agentIntegrationSection!);
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
