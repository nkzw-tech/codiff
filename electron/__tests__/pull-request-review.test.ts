import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

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
  await using directory = await createTemporaryDirectory('codiff-pull-request-review-');
  const repo = join(directory.path, 'repo');
  const fakeBin = join(directory.path, 'bin');
  const fakeGh = join(fakeBin, 'gh');
  const callsPath = join(directory.path, 'calls.jsonl');

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
  process.stdout.write(
    args.includes('repos/nkzw-tech/codiff/pulls/12')
      ? '{"head":{"sha":"0123456789abcdef0123456789abcdef01234567"}}'
      : '{}',
  );
});
`,
  );
  await chmod(fakeGh, 0o755);

  await using _environment = createTemporaryEnvironment({
    CODIFF_GITHUB_REVIEW_TEST_CALLS: callsPath,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  });

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
  const reviewCalls = calls.filter((call) =>
    call.args.includes('repos/nkzw-tech/codiff/pulls/12/reviews'),
  );
  expect(reviewCalls).toHaveLength(3);
  expect(JSON.parse(reviewCalls[0].input)).toEqual({
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
  expect(JSON.parse(reviewCalls[1].input)).toEqual({
    body: 'General feedback.',
    comments: [],
    event: 'COMMENT',
  });
  expect(JSON.parse(reviewCalls[2].input)).toEqual({
    body: 'Requesting changes.',
    comments: [],
    event: 'REQUEST_CHANGES',
  });
});
