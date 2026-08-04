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
import type { GitSha, SubmitPullRequestReviewResult } from '../../core/types.ts';

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
  ) => Promise<SubmitPullRequestReviewResult>;
};

const execFileAsync = promisify(execFile);

test('submits normalized GitHub review payloads through the GitHub CLI', async () => {
  await using directory = await createTemporaryDirectory('codiff-pull-request-review-');
  const repo = join(directory.path, 'repo');
  const fakeBin = join(directory.path, 'bin');
  const fakeGh = join(fakeBin, 'gh');
  const callsPath = join(directory.path, 'calls.jsonl');
  const baseSha = 'a'.repeat(40);
  const advancedBaseTipSha = 'c'.repeat(40);
  const headSha = 'b'.repeat(40);

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
  const endpoint = args.find((argument) => argument.startsWith('/repos/')) || '';
  if (endpoint.includes('/compare/')) {
    process.stdout.write(JSON.stringify({ merge_base_commit: { sha: '${baseSha}' } }));
    return;
  }
  if (endpoint.endsWith('/files?per_page=100')) {
    process.stdout.write(JSON.stringify([{
      filename: 'src/app.ts',
      patch: '@@ -7 +7 @@\\n-old\\n+new\\n',
    }]));
    return;
  }
  process.stdout.write(endpoint.endsWith('/pulls/12')
    ? JSON.stringify({
        base: { sha: '${advancedBaseTipSha}' },
        head: { sha: '${headSha}' },
      })
    : '{}');
});
`,
  );
  await chmod(fakeGh, 0o755);

  await using _environment = createTemporaryEnvironment({
    CODIFF_GITHUB_REVIEW_TEST_CALLS: callsPath,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    SHELL: undefined,
  });

  const source = {
    headSha: headSha as GitSha,
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
        localDraftId: 'draft-1',
        position: {
          range: {
            base: {
              label: { kind: 'commit' as const, text: 'aaaaaaa' },
              sha: baseSha as GitSha,
            },
            head: {
              label: { kind: 'commit' as const, text: 'bbbbbbb' },
              sha: headSha as GitSha,
            },
          },
        },
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
  ).resolves.toEqual({
    reason: 'A comment review requires an inline comment or a review comment.',
    status: 'failed',
    submittedDraftIds: [],
  });
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
    call.args.includes('/repos/nkzw-tech/codiff/pulls/12/reviews'),
  );
  const endpoints = calls.flatMap((call) =>
    call.args.filter((argument) => argument.startsWith('/repos/')),
  );
  const metadataPath = '/repos/nkzw-tech/codiff/pulls/12';
  const comparePath = `/repos/nkzw-tech/codiff/compare/${advancedBaseTipSha}...${headSha}`;
  expect(endpoints).toContain(comparePath);
  expect(endpoints.indexOf(metadataPath)).toBeLessThan(endpoints.indexOf(comparePath));
  expect(reviewCalls).toHaveLength(3);
  expect(JSON.parse(reviewCalls[0].input)).toEqual({
    body: 'Review comments.',
    commit_id: headSha,
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
    commit_id: headSha,
    comments: [],
    event: 'COMMENT',
  });
  expect(JSON.parse(reviewCalls[2].input)).toEqual({
    body: 'Requesting changes.',
    commit_id: headSha,
    comments: [],
    event: 'REQUEST_CHANGES',
  });
});

test.each([
  {
    expectedReason: 'head changed',
    mergeBaseSha: 'a'.repeat(40),
    metadataHeadSha: 'd'.repeat(40),
    name: 'changed head',
  },
  {
    expectedReason: 'draft range no longer matches',
    mergeBaseSha: 'e'.repeat(40),
    metadataHeadSha: 'b'.repeat(40),
    name: 'changed merge base',
  },
  {
    expectedReason: 'did not return the current pull request merge base',
    mergeBaseSha: null,
    metadataHeadSha: 'b'.repeat(40),
    name: 'missing merge base',
  },
])(
  'rejects a $name before mutating GitHub',
  async ({ expectedReason, mergeBaseSha, metadataHeadSha }) => {
    await using directory = await createTemporaryDirectory('codiff-pull-request-review-');
    const repo = join(directory.path, 'repo');
    const fakeBin = join(directory.path, 'bin');
    const fakeGh = join(fakeBin, 'gh');
    const callsPath = join(directory.path, 'calls.jsonl');
    const draftBaseSha = 'a'.repeat(40);
    const baseTipSha = 'c'.repeat(40);
    const draftHeadSha = 'b'.repeat(40);

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
  const endpoint = args.find((argument) => argument.startsWith('/repos/')) || '';
  if (endpoint.includes('/compare/')) {
    process.stdout.write(${JSON.stringify(
      JSON.stringify(mergeBaseSha ? { merge_base_commit: { sha: mergeBaseSha } } : {}),
    )});
    return;
  }
  if (endpoint.endsWith('/files?per_page=100')) {
    process.stdout.write(JSON.stringify([{
      filename: 'src/app.ts',
      patch: '@@ -7 +7 @@\\n-old\\n+new\\n',
    }]));
    return;
  }
  process.stdout.write(endpoint.endsWith('/pulls/12')
    ? ${JSON.stringify(
      JSON.stringify({
        base: { sha: baseTipSha },
        head: { sha: metadataHeadSha },
      }),
    )}
    : '{}');
});
`,
    );
    await chmod(fakeGh, 0o755);

    await using _environment = createTemporaryEnvironment({
      CODIFF_GITHUB_REVIEW_TEST_CALLS: callsPath,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    });

    const result = await submitPullRequestReview(repo, {
      comments: [
        {
          body: 'Please keep this explicit.',
          filePath: 'src/app.ts',
          lineNumber: 7,
          localDraftId: 'draft-1',
          position: {
            range: {
              base: {
                label: { kind: 'commit' as const, text: 'aaaaaaa' },
                sha: draftBaseSha as GitSha,
              },
              head: {
                label: { kind: 'commit' as const, text: 'bbbbbbb' },
                sha: draftHeadSha as GitSha,
              },
            },
          },
          side: 'additions',
        },
      ],
      event: 'COMMENT',
      source: {
        headSha: draftHeadSha as GitSha,
        provider: 'github',
        type: 'pull-request',
        url: 'https://github.com/nkzw-tech/codiff/pull/12',
      },
    });

    expect(result).toMatchObject({
      reason: expect.stringContaining(expectedReason),
      status: 'failed',
      submittedDraftIds: [],
    });
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: ReadonlyArray<string> });
    expect(
      calls.filter((call) => call.args.includes('/repos/nkzw-tech/codiff/pulls/12/reviews')),
    ).toHaveLength(0);
  },
);
