import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vite-plus/test';
import { createTemporaryDirectory, createTemporaryEnvironment } from './helpers/resources.ts';

const require = createRequire(import.meta.url);
type GitLabPosition = Record<string, unknown> & {
  line_range?: {
    end: Record<string, unknown>;
    start: Record<string, unknown>;
  };
};
const {
  createGitLabPosition,
  createMergeRequestFetchRefspecs,
  normalizeGitLabReviewComment,
  parseGitLabMergeRequestUrl,
  submitMergeRequestComment,
  submitMergeRequestReview,
} = require('../../electron/git-state/merge-request.cjs') as {
  createGitLabPosition: (
    comment: Record<string, unknown>,
    metadata: Record<string, unknown>,
    diff?: Record<string, unknown>,
  ) => GitLabPosition;
  createMergeRequestFetchRefspecs: (
    mergeRequest: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) => ReadonlyArray<string>;
  normalizeGitLabReviewComment: (
    note: Record<string, unknown>,
    url: string,
  ) => Record<string, unknown> | null;
  parseGitLabMergeRequestUrl: (url: string) => Record<string, unknown>;
  submitMergeRequestComment: (
    launchPath: string,
    request: {
      comment: Record<string, unknown>;
      source: Record<string, unknown>;
    },
  ) => Promise<Record<string, unknown>>;
  submitMergeRequestReview: (
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

type GlabCall = {
  args: ReadonlyArray<string>;
  input: string;
};

const withFakeGitLab = async (
  callback: (repo: string, readCalls: () => Promise<ReadonlyArray<GlabCall>>) => Promise<void>,
) => {
  await using directory = await createTemporaryDirectory('codiff-gitlab-');
  const repo = join(directory.path, 'repo');
  const fakeGlabPath = join(directory.path, 'glab');
  const callsPath = join(directory.path, 'calls.jsonl');

  await execFileAsync('git', ['init', repo]);
  await execFileAsync('git', [
    '-C',
    repo,
    'remote',
    'add',
    'origin',
    'ssh://git@gitlab.example.com/group/project.git',
  ]);
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const endpoint = args.at(-1) || '';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  appendFileSync(process.env.CODIFF_GLAB_TEST_CALLS, JSON.stringify({ args, input }) + '\\n');
  if (endpoint.endsWith('/diffs?per_page=100')) {
    process.stdout.write(
      '[{"diff":"@@ -10,2 +12,2 @@\\\\n context\\\\n-old\\\\n+new\\\\n","new_path":"src/new.ts","old_path":"src/old.ts"}]' +
        '[{"diff":"@@ -1 +1 @@\\\\n-old\\\\n+new\\\\n","new_path":"src/other.ts","old_path":"src/other.ts"}]',
    );
    return;
  }
  if (endpoint.endsWith('/discussions/discussion%2Fwith%20spaces/notes')) {
    process.stdout.write(JSON.stringify({
      author: { username: 'reviewer' },
      body: 'Reply in the existing discussion.',
      created_at: '2026-07-08T00:00:00Z',
      id: 46,
    }));
    return;
  }
  if (endpoint.endsWith('/merge_requests/23')) {
    process.stdout.write(JSON.stringify({
      diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' },
    }));
    return;
  }
  process.stdout.write('{}');
});
`,
  );
  await chmod(fakeGlabPath, 0o755);
  await using _environment = createTemporaryEnvironment({
    CODIFF_GLAB_PATH: fakeGlabPath,
    CODIFF_GLAB_TEST_CALLS: callsPath,
  });

  await callback(repo, async () =>
    (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GlabCall),
  );
};

describe('GitLab merge requests', () => {
  test('parses arbitrary hosts and nested project paths', () => {
    expect(
      parseGitLabMergeRequestUrl(
        'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23',
      ),
    ).toMatchObject({
      host: 'gitlab.example.com',
      number: 23,
      projectPath: 'group/subgroup/project',
      provider: 'gitlab',
    });
  });

  test('builds local head and target branch fetch refspecs', () => {
    expect(
      createMergeRequestFetchRefspecs(
        { number: 23 },
        {
          target_branch: 'main',
        },
      ),
    ).toEqual([
      '+refs/merge-requests/23/head:refs/codiff/merge-requests/23/head',
      '+refs/heads/main:refs/codiff/merge-requests/23/base',
    ]);
  });

  test('builds single-line and ranged GitLab diff positions', () => {
    const metadata = {
      diff_refs: {
        base_sha: 'base',
        head_sha: 'head',
        start_sha: 'start',
      },
    };
    expect(
      createGitLabPosition(
        {
          body: 'Comment',
          filePath: 'src/a.ts',
          lineNumber: 12,
          side: 'additions',
        },
        metadata,
      ),
    ).toMatchObject({
      base_sha: 'base',
      head_sha: 'head',
      new_line: 12,
      new_path: 'src/a.ts',
      old_path: 'src/a.ts',
      position_type: 'text',
      start_sha: 'start',
    });

    const ranged = createGitLabPosition(
      {
        body: 'Comment',
        filePath: 'src/a.ts',
        lineNumber: 12,
        side: 'additions',
        startLineNumber: 10,
      },
      metadata,
    );
    expect(ranged.line_range?.start).toMatchObject({ new_line: 10, type: 'new' });
    expect(ranged.line_range?.end).toMatchObject({ new_line: 12, type: 'new' });
    expect(ranged.line_range?.start.line_code).toMatch(/^[0-9a-f]{40}_0_10$/);
  });

  test('builds file-level GitLab positions without line metadata', () => {
    expect(
      createGitLabPosition(
        {
          anchor: 'file',
          body: 'Review the file as a whole.',
          filePath: 'src/a.ts',
        },
        {
          diff_refs: {
            base_sha: 'base',
            head_sha: 'head',
            start_sha: 'start',
          },
        },
        {
          new_path: 'src/new.ts',
          old_path: 'src/old.ts',
        },
      ),
    ).toEqual({
      base_sha: 'base',
      head_sha: 'head',
      new_path: 'src/new.ts',
      old_path: 'src/old.ts',
      position_type: 'file',
      start_sha: 'start',
    });
  });

  test('maps unchanged lines and renamed paths for GitLab positions', () => {
    const diff = {
      diff: '@@ -10,3 +12,4 @@\n context\n-old\n+new\n added\n',
      new_path: 'src/new.ts',
      old_path: 'src/old.ts',
    };
    expect(
      createGitLabPosition(
        {
          body: 'Comment',
          filePath: 'src/new.ts',
          lineNumber: 12,
          side: 'additions',
        },
        { diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' } },
        diff,
      ),
    ).toMatchObject({
      new_line: 12,
      new_path: 'src/new.ts',
      old_line: 10,
      old_path: 'src/old.ts',
    });
  });

  test('normalizes GitLab diff notes for the renderer', () => {
    expect(
      normalizeGitLabReviewComment(
        {
          author: { username: 'reviewer' },
          body: 'Please change this.',
          created_at: '2026-06-17T00:00:00Z',
          id: 44,
          position: {
            new_line: 12,
            new_path: 'src/a.ts',
            old_path: 'src/a.ts',
          },
        },
        'https://gitlab.example.com/group/project/-/merge_requests/23',
      ),
    ).toMatchObject({
      author: { login: 'reviewer' },
      body: 'Please change this.',
      filePath: 'src/a.ts',
      id: 'gitlab:44',
      lineNumber: 12,
      side: 'additions',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/23#note_44',
    });
  });

  test('normalizes file-level GitLab notes without line metadata', () => {
    expect(
      normalizeGitLabReviewComment(
        {
          author: { username: 'reviewer' },
          body: 'Please review the file structure.',
          created_at: '2026-07-08T00:00:00Z',
          id: 45,
          position: {
            new_path: 'src/a.ts',
            old_path: 'src/a.ts',
            position_type: 'file',
          },
        },
        'https://gitlab.example.com/group/project/-/merge_requests/23',
      ),
    ).toMatchObject({
      anchor: 'file',
      author: { login: 'reviewer' },
      body: 'Please review the file structure.',
      filePath: 'src/a.ts',
      id: 'gitlab:45',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/23#note_45',
    });
  });

  test('submits GitLab reviews with paginated diffs and JSON request bodies', async () => {
    await withFakeGitLab(async (repo, readCalls) => {
      const source = {
        provider: 'gitlab',
        type: 'pull-request',
        url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
      };

      await submitMergeRequestReview(repo, {
        body: 'Looks good.',
        comments: [
          {
            body: 'Keep this explicit.',
            filePath: 'src/new.ts',
            lineNumber: 12,
            side: 'additions',
          },
        ],
        event: 'APPROVE',
        source,
      });
      await submitMergeRequestReview(repo, {
        comments: [],
        event: 'REQUEST_CHANGES',
        source,
      });
      await expect(
        submitMergeRequestReview(repo, {
          comments: [],
          event: 'COMMENT',
          source,
        }),
      ).rejects.toThrow('GitLab merge request reviews do not support COMMENT.');

      const calls = await readCalls();
      const requestsWithBodies = calls.filter((call) => call.input);
      for (const call of requestsWithBodies) {
        expect(call.args).toContain('--header');
        expect(call.args).toContain('Content-Type: application/json');
      }

      const draftCall = calls.find((call) => call.args.at(-1)?.endsWith('/draft_notes'));
      expect(JSON.parse(draftCall?.input || '')).toMatchObject({
        note: 'Keep this explicit.',
        position: {
          new_line: 12,
          new_path: 'src/new.ts',
          old_line: 10,
          old_path: 'src/old.ts',
        },
      });

      const noteBodies = calls
        .filter((call) => call.args.at(-1)?.endsWith('/notes'))
        .map((call) => JSON.parse(call.input).body);
      expect(noteBodies).toEqual([
        'Looks good.\n\n/submit_review approve',
        '/submit_review request_changes',
      ]);
    });
  });

  test('preserves submitted metadata when GitLab discussion replies omit positions', async () => {
    await withFakeGitLab(async (repo, readCalls) => {
      await expect(
        submitMergeRequestComment(repo, {
          comment: {
            anchor: 'file',
            body: 'Reply in the existing discussion.',
            filePath: 'src/a.ts',
            threadId: 'discussion/with spaces',
          },
          source: {
            provider: 'gitlab',
            type: 'pull-request',
            url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
          },
        }),
      ).resolves.toMatchObject({
        anchor: 'file',
        body: 'Reply in the existing discussion.',
        filePath: 'src/a.ts',
        id: 'gitlab:46',
        threadId: 'discussion/with spaces',
        url: 'https://gitlab.example.com/group/project/-/merge_requests/23#note_46',
      });

      const [call] = await readCalls();
      expect(call.args.at(-1)).toBe(
        'projects/group%2Fproject/merge_requests/23/discussions/discussion%2Fwith%20spaces/notes',
      );
      expect(call.args).toContain('Content-Type: application/json');
      expect(JSON.parse(call.input)).toEqual({ body: 'Reply in the existing discussion.' });
    });
  });
});
