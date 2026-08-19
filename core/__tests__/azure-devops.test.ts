import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vite-plus/test';
import { createTemporaryDirectory, createTemporaryEnvironment } from './helpers/resources.ts';

const require = createRequire(import.meta.url);
const {
  AZ_NOT_FOUND_CODE,
  createAzureDevOpsFetchRefspecs,
  createAzureDevOpsThreadContext,
  getAzCommand,
  normalizeAzureDevOpsReviewComment,
  parseAzureDevOpsPullRequestUrl,
  submitAzureDevOpsComment,
  submitAzureDevOpsReview,
} = require('../../electron/git-state/azure-devops.cjs') as {
  AZ_NOT_FOUND_CODE: string;
  createAzureDevOpsFetchRefspecs: (
    pullRequest: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) => ReadonlyArray<string>;
  createAzureDevOpsThreadContext: (comment: Record<string, unknown>) => Record<string, unknown>;
  getAzCommand: () => string;
  normalizeAzureDevOpsReviewComment: (
    comment: Record<string, unknown>,
    thread: Record<string, unknown>,
    url: string,
  ) => Record<string, unknown> | null;
  parseAzureDevOpsPullRequestUrl: (url: string) => Record<string, unknown>;
  submitAzureDevOpsComment: (
    launchPath: string,
    request: {
      comment: Record<string, unknown>;
      source: Record<string, unknown>;
    },
  ) => Promise<Record<string, unknown>>;
  submitAzureDevOpsReview: (
    launchPath: string,
    request: {
      body?: string;
      comments: ReadonlyArray<Record<string, unknown>>;
      event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
      source: Record<string, unknown>;
    },
  ) => Promise<void>;
};

const execFileAsync = promisify(execFile);

type AzCall = {
  args: ReadonlyArray<string>;
};

const withFakeAzureDevOps = async (
  callback: (repo: string, readCalls: () => Promise<ReadonlyArray<AzCall>>) => Promise<void>,
) => {
  await using directory = await createTemporaryDirectory('codiff-azure-devops-');
  const repo = join(directory.path, 'repo');
  const fakeAzPath = join(directory.path, 'az');
  const callsPath = join(directory.path, 'calls.jsonl');

  await execFileAsync('git', ['init', repo]);
  await execFileAsync('git', [
    '-C',
    repo,
    'remote',
    'add',
    'origin',
    'git@ssh.dev.azure.com:v3/mpc-tech-hub/MPCM/Dashboard',
  ]);
  await writeFile(
    fakeAzPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const uriIndex = args.indexOf('--uri');
const uri = uriIndex >= 0 ? args[uriIndex + 1] : '';
const methodIndex = args.indexOf('--method');
const method = (methodIndex >= 0 ? args[methodIndex + 1] : 'GET').toUpperCase();
const bodyIndex = args.indexOf('--body');
const body = bodyIndex >= 0 ? args[bodyIndex + 1] : '';
appendFileSync(process.env.CODIFF_AZ_TEST_CALLS, JSON.stringify({ args }) + '\\n');
if (method === 'POST' && uri.includes('/threads/') && uri.includes('/comments')) {
  process.stdout.write(JSON.stringify({
    author: { displayName: 'Ada', uniqueName: 'ada@contoso.com' },
    commentType: 1,
    content: JSON.parse(body).content,
    id: 2,
    publishedDate: '2026-08-19T00:00:00Z',
  }));
  return;
}
if (method === 'POST' && /\\/threads\\?/.test(uri)) {
  const payload = JSON.parse(body);
  process.stdout.write(JSON.stringify({
    comments: [{
      author: { displayName: 'Ada', uniqueName: 'ada@contoso.com' },
      commentType: 1,
      content: payload.comments[0].content,
      id: 1,
      publishedDate: '2026-08-19T00:00:00Z',
    }],
    id: 18,
    threadContext: payload.threadContext || null,
  }));
  return;
}
if (uri.includes('/connectionData')) {
  process.stdout.write(JSON.stringify({ authenticatedUser: { id: 'user-1' } }));
  return;
}
if (method === 'PUT' && uri.includes('/reviewers/')) {
  process.stdout.write(JSON.stringify({ id: 'user-1', vote: 10 }));
  return;
}
if (uri.includes('/pullRequests/492?')) {
  process.stdout.write(JSON.stringify({
    createdBy: { displayName: 'Ada' },
    lastMergeSourceCommit: { commitId: 'abc' },
    targetRefName: 'refs/heads/main',
    title: 'Add Azure DevOps reviews',
  }));
  return;
}
process.stdout.write('{}');
`,
  );
  await chmod(fakeAzPath, 0o755);
  await using _environment = createTemporaryEnvironment({
    CODIFF_AZ_PATH: fakeAzPath,
    CODIFF_AZ_TEST_CALLS: callsPath,
    SHELL: undefined,
  });

  await callback(repo, async () =>
    (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AzCall),
  );
};

describe('Azure DevOps pull requests', () => {
  test('parses cloud and visualstudio pull request URLs', () => {
    expect(
      parseAzureDevOpsPullRequestUrl(
        'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
      ),
    ).toMatchObject({
      host: 'dev.azure.com',
      number: 492,
      organization: 'mpc-tech-hub',
      project: 'MPCM',
      provider: 'azure-devops',
      repo: 'Dashboard',
    });
  });

  test('builds local head and target branch fetch refspecs', () => {
    expect(
      createAzureDevOpsFetchRefspecs(
        { number: 492 },
        {
          targetRefName: 'refs/heads/main',
        },
      ),
    ).toEqual([
      '+refs/pull/492/head:refs/codiff/pull-requests/492/head',
      '+refs/heads/main:refs/codiff/pull-requests/492/base',
    ]);
  });

  test('builds Azure DevOps thread positions for lines and files', () => {
    expect(
      createAzureDevOpsThreadContext({
        body: 'Comment',
        filePath: 'src/a.ts',
        lineNumber: 12,
        side: 'additions',
      }),
    ).toEqual({
      filePath: '/src/a.ts',
      rightFileEnd: { line: 12, offset: 1 },
      rightFileStart: { line: 12, offset: 1 },
    });
    expect(
      createAzureDevOpsThreadContext({
        body: 'Comment',
        filePath: 'src/a.ts',
        lineNumber: 8,
        side: 'deletions',
        startLineNumber: 6,
      }),
    ).toEqual({
      filePath: '/src/a.ts',
      leftFileEnd: { line: 8, offset: 1 },
      leftFileStart: { line: 6, offset: 1 },
    });
    expect(
      createAzureDevOpsThreadContext({
        anchor: 'file',
        body: 'Review the file.',
        filePath: 'src/a.ts',
      }),
    ).toEqual({ filePath: '/src/a.ts' });
  });

  test('normalizes Azure DevOps threads for the renderer', () => {
    expect(
      normalizeAzureDevOpsReviewComment(
        {
          author: { displayName: 'Ada', uniqueName: 'ada@contoso.com' },
          content: 'Please change this.',
          id: 1,
          publishedDate: '2026-08-19T00:00:00Z',
        },
        {
          id: 18,
          threadContext: {
            filePath: '/src/a.ts',
            rightFileEnd: { line: 12, offset: 1 },
            rightFileStart: { line: 12, offset: 1 },
          },
        },
        'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
      ),
    ).toMatchObject({
      author: { login: 'ada@contoso.com' },
      body: 'Please change this.',
      filePath: 'src/a.ts',
      id: 'azure-devops:18:1',
      lineNumber: 12,
      side: 'additions',
      threadId: '18',
      url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/42?discussionId=18',
    });
  });

  test('normalizes file-level Azure DevOps threads without line metadata', () => {
    expect(
      normalizeAzureDevOpsReviewComment(
        {
          author: { displayName: 'Ada' },
          content: 'Please review the file structure.',
          id: 2,
          publishedDate: '2026-08-19T00:00:00Z',
        },
        {
          id: 19,
          threadContext: { filePath: '/src/a.ts' },
        },
        'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
      ),
    ).toMatchObject({
      anchor: 'file',
      filePath: 'src/a.ts',
      id: 'azure-devops:19:2',
    });
  });

  test('resolves the Azure CLI from an explicit override', async () => {
    await using directory = await createTemporaryDirectory('codiff-az-command-');
    const fakeAz = join(directory.path, 'az');
    await writeFile(fakeAz, '#!/bin/sh\nexit 0\n');
    await chmod(fakeAz, 0o755);
    await using _environment = createTemporaryEnvironment({ CODIFF_AZ_PATH: fakeAz });
    expect(getAzCommand()).toBe(fakeAz);
  });

  test('rejects invalid explicit Azure CLI overrides', async () => {
    await using _environment = createTemporaryEnvironment({
      CODIFF_AZ_PATH: '/tmp/codiff-missing-az',
    });
    expect(() => getAzCommand()).toThrow('CODIFF_AZ_PATH');
    try {
      getAzCommand();
    } catch (error) {
      expect(error).toMatchObject({ code: AZ_NOT_FOUND_CODE });
    }
  });

  test('submits Azure DevOps comments and reviews through az rest', async () => {
    await withFakeAzureDevOps(async (repo, readCalls) => {
      const source = {
        provider: 'azure-devops',
        type: 'pull-request',
        url: 'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
      };

      await expect(
        submitAzureDevOpsComment(repo, {
          comment: {
            body: 'Keep this explicit.',
            filePath: 'src/a.ts',
            lineNumber: 12,
            side: 'additions',
          },
          source,
        }),
      ).resolves.toMatchObject({
        body: 'Keep this explicit.',
        filePath: 'src/a.ts',
        id: 'azure-devops:18:1',
        threadId: '18',
      });

      await submitAzureDevOpsReview(repo, {
        body: 'Looks good.',
        comments: [
          {
            body: 'Nit.',
            filePath: 'src/a.ts',
            lineNumber: 12,
            side: 'additions',
          },
        ],
        event: 'APPROVE',
        source,
      });

      const calls = await readCalls();
      const uris = calls.map((call) => call.args[call.args.indexOf('--uri') + 1]);
      expect(uris.some((uri) => uri.includes('/threads?'))).toBe(true);
      expect(uris.some((uri) => uri.includes('/reviewers/user-1'))).toBe(true);
      expect(
        calls.every((call) => call.args.includes('499b84ac-1321-427f-aa17-267ca6975798')),
      ).toBe(true);
    });
  });

  test('authenticates az from the login shell environment when the app inherited none', async () => {
    await using directory = await createTemporaryDirectory('codiff-az-login-env-');
    const repo = join(directory.path, 'repo');
    const fakeAz = join(directory.path, 'az');
    const fakeShell = join(directory.path, 'fake-login-shell');

    await execFileAsync('git', ['init', repo]);
    await execFileAsync('git', [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      'git@ssh.dev.azure.com:v3/mpc-tech-hub/MPCM/Dashboard',
    ]);

    await writeFile(
      fakeShell,
      `#!/bin/sh
AZURE_DEVOPS_EXT_PAT='from-login-shell' exec /bin/sh -c "$4"
`,
    );
    await writeFile(
      fakeAz,
      `#!/bin/sh
if [ "$AZURE_DEVOPS_EXT_PAT" != 'from-login-shell' ]; then
  echo 'Please run az login' >&2
  exit 1
fi
printf '%s' '{"authenticatedUser":{"id":"user-1"}}'
`,
    );
    await Promise.all([chmod(fakeShell, 0o755), chmod(fakeAz, 0o755)]);

    await using _environment = createTemporaryEnvironment({
      AZURE_DEVOPS_EXT_PAT: undefined,
      CODIFF_AZ_PATH: fakeAz,
      SHELL: fakeShell,
    });

    await submitAzureDevOpsReview(repo, {
      comments: [],
      event: 'REQUEST_CHANGES',
      source: {
        provider: 'azure-devops',
        type: 'pull-request',
        url: 'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
      },
    });
  });
});
