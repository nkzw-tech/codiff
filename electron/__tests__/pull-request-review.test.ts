import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { removeGitTestDirectory } from '../../core/__tests__/helpers/git.ts';

const require = createRequire(import.meta.url);
const { submitPullRequestReview } = require('../git-state/pull-request.cjs') as {
  submitPullRequestReview: (
    launchPath: string,
    request: {
      body?: string;
      comments: ReadonlyArray<Record<string, unknown>>;
      event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
      source: {
        provider: 'github';
        type: 'pull-request';
        url: string;
      };
    },
  ) => Promise<void>;
};

const execFileAsync = promisify(execFile);

test('submits normalized GitHub review payloads through the GitHub CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-pull-request-review-'));
  const repo = join(directory, 'repo');
  const fakeBin = join(directory, 'bin');
  const fakeGh = join(fakeBin, 'gh');
  const callsPath = join(directory, 'calls.jsonl');
  const previousPath = process.env.PATH;
  const previousCallsPath = process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS;

  try {
    await Promise.all([mkdir(repo), mkdir(fakeBin)]);
    await execFileAsync('git', ['-C', repo, 'init']);
    await execFileAsync('git', [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:nkzw-tech/codiff.git',
    ]);
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  appendFileSync(
    process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS,
    JSON.stringify({ args, input }) + '\\n',
  );
  process.stdout.write('{}');
});
`,
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS = callsPath;

    const source = {
      provider: 'github' as const,
      type: 'pull-request' as const,
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    };

    await submitPullRequestReview(repo, {
      comments: [
        {
          body: 'Please keep this explicit.',
          filePath: 'src/app.ts',
          lineNumber: 7,
          side: 'additions',
        },
      ],
      event: 'COMMENT',
      source,
    });
    await submitPullRequestReview(repo, {
      body: '  General feedback.  ',
      comments: [],
      event: 'COMMENT',
      source,
    });
    await expect(
      submitPullRequestReview(repo, {
        body: '   ',
        comments: [],
        event: 'COMMENT',
        source,
      }),
    ).rejects.toThrow('A comment review requires an inline comment or a review comment.');
    await submitPullRequestReview(repo, {
      comments: [],
      event: 'REQUEST_CHANGES',
      source,
    });

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            args: ReadonlyArray<string>;
            input: string;
          },
      );
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args).toContain('repos/nkzw-tech/codiff/pulls/12/reviews');
    }
    expect(JSON.parse(calls[0].input)).toEqual({
      body: '',
      comments: [
        {
          body: 'Please keep this explicit.',
          line: 7,
          path: 'src/app.ts',
          side: 'RIGHT',
        },
      ],
      event: 'COMMENT',
    });
    expect(JSON.parse(calls[1].input)).toEqual({
      body: 'General feedback.',
      comments: [],
      event: 'COMMENT',
    });
    expect(JSON.parse(calls[2].input)).toEqual({
      body: 'Requesting changes.',
      comments: [],
      event: 'REQUEST_CHANGES',
    });
  } finally {
    if (previousPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousCallsPath == null) {
      delete process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS;
    } else {
      process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS = previousCallsPath;
    }
    await removeGitTestDirectory(directory);
  }
});

test('matches pull requests to remotes with custom SSH users or through gh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-pull-request-review-'));
  const sshUserRepo = join(directory, 'ssh-user-repo');
  const aliasedRepo = join(directory, 'aliased-repo');
  const fakeBin = join(directory, 'bin');
  const fakeGh = join(fakeBin, 'gh');
  const callsPath = join(directory, 'calls.jsonl');
  const previousPath = process.env.PATH;
  const previousCallsPath = process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS;

  try {
    await Promise.all([mkdir(sshUserRepo), mkdir(aliasedRepo), mkdir(fakeBin)]);
    await execFileAsync('git', ['-C', sshUserRepo, 'init']);
    await execFileAsync('git', [
      '-C',
      sshUserRepo,
      'remote',
      'add',
      'origin',
      'org-12345@github.com:acme/widgets.git',
    ]);
    await execFileAsync('git', ['-C', aliasedRepo, 'init']);
    await execFileAsync('git', [
      '-C',
      aliasedRepo,
      'remote',
      'add',
      'origin',
      'git@github-work:acme/widgets.git',
    ]);
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  appendFileSync(
    process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS,
    JSON.stringify({ args, input }) + '\\n',
  );
  process.stdout.write(
    args[0] === 'repo' && args[1] === 'view'
      ? '{"owner":{"login":"acme"},"name":"widgets"}'
      : '{}',
  );
});
`,
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS = callsPath;

    const review = {
      body: 'Looks good.',
      comments: [],
      event: 'APPROVE' as const,
      source: {
        provider: 'github' as const,
        type: 'pull-request' as const,
        url: 'https://github.com/acme/widgets/pull/42',
      },
    };

    await submitPullRequestReview(sshUserRepo, review);
    await submitPullRequestReview(aliasedRepo, review);

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: ReadonlyArray<string>; input: string });
    expect(calls).toHaveLength(3);
    // The custom SSH user matches through remote parsing alone — no gh lookup.
    expect(calls[0].args).toContain('repos/acme/widgets/pulls/42/reviews');
    // The aliased host hides github.com, so the repository resolves through gh.
    expect(calls[1].args.join(' ')).toBe('repo view --json owner,name');
    expect(calls[2].args).toContain('repos/acme/widgets/pulls/42/reviews');
  } finally {
    if (previousPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousCallsPath == null) {
      delete process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS;
    } else {
      process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS = previousCallsPath;
    }
    await removeGitTestDirectory(directory);
  }
});
