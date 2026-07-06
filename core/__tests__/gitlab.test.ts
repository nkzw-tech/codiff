import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
type GitLabPosition = Record<string, unknown> & {
  line_range?: {
    end: Record<string, unknown>;
    start: Record<string, unknown>;
  };
};
const {
  createGitLabDiffLineMap,
  createGitLabPosition,
  createGlabApiArgs,
  createMergeRequestFetchRefspecs,
  createMergeRequestSource,
  getGitLabReviewQuickAction,
  getGlabCommand,
  GLAB_NOT_FOUND_CODE,
  GLAB_NOT_FOUND_MESSAGE,
  normalizeGitLabReviewComment,
  parseGitLabMergeRequestUrl,
  parseGlabJsonPages,
} = require('../../electron/git-state/merge-request.cjs') as {
  createGitLabDiffLineMap: (diff: string) => Map<string, { newLine?: number; oldLine?: number }>;
  createGitLabPosition: (
    comment: Record<string, unknown>,
    metadata: Record<string, unknown>,
    diff?: Record<string, unknown>,
  ) => GitLabPosition;
  createGlabApiArgs: (
    mergeRequest: { host: string },
    args: ReadonlyArray<string>,
    input?: unknown,
  ) => ReadonlyArray<string>;
  createMergeRequestFetchRefspecs: (
    mergeRequest: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) => ReadonlyArray<string>;
  createMergeRequestSource: (
    mergeRequest: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) => Record<string, unknown>;
  getGitLabReviewQuickAction: (event: 'APPROVE' | 'REQUEST_CHANGES') => string;
  getGlabCommand: () => string;
  GLAB_NOT_FOUND_CODE: string;
  GLAB_NOT_FOUND_MESSAGE: string;
  normalizeGitLabReviewComment: (
    note: Record<string, unknown>,
    url: string,
  ) => Record<string, unknown> | null;
  parseGitLabMergeRequestUrl: (url: string) => Record<string, unknown>;
  parseGlabJsonPages: (value: string) => ReadonlyArray<Record<string, unknown>>;
};
const { parseRemoteUrl } = require('../../electron/review-source.cjs') as {
  parseRemoteUrl: (url: string) => Record<string, unknown> | null;
};

describe('GitLab merge requests', () => {
  test('sends JSON content types for glab request bodies', () => {
    expect(
      createGlabApiArgs(
        { host: 'gitlab.example.com' },
        ['--method', 'POST', '--input', '-', 'projects/1/merge_requests/2/discussions'],
        { body: 'Comment', position: {} },
      ),
    ).toEqual([
      'api',
      '--hostname',
      'gitlab.example.com',
      '--header',
      'Content-Type: application/json',
      '--method',
      'POST',
      '--input',
      '-',
      'projects/1/merge_requests/2/discussions',
    ]);
  });

  test('resolves glab from the CODIFF_GLAB_PATH override', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codiff-glab-'));
    const fakeGlabPath = join(directory, 'glab');
    const previousGlabPath = process.env.CODIFF_GLAB_PATH;

    try {
      await writeFile(fakeGlabPath, '#!/usr/bin/env node\n');
      await chmod(fakeGlabPath, 0o755);
      process.env.CODIFF_GLAB_PATH = fakeGlabPath;

      expect(getGlabCommand()).toBe(fakeGlabPath);
    } finally {
      if (previousGlabPath == null) {
        delete process.env.CODIFF_GLAB_PATH;
      } else {
        process.env.CODIFF_GLAB_PATH = previousGlabPath;
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('rejects invalid explicit glab CLI overrides', () => {
    const previousGlabPath = process.env.CODIFF_GLAB_PATH;
    process.env.CODIFF_GLAB_PATH = '/tmp/codiff-missing-glab';

    try {
      expect(() => getGlabCommand()).toThrow('CODIFF_GLAB_PATH');
      try {
        getGlabCommand();
      } catch (error) {
        expect(error).toMatchObject({ code: GLAB_NOT_FOUND_CODE });
      }
    } finally {
      if (previousGlabPath == null) {
        delete process.env.CODIFF_GLAB_PATH;
      } else {
        process.env.CODIFF_GLAB_PATH = previousGlabPath;
      }
    }
  });

  test('explains where Codiff searches for glab when it is missing', () => {
    expect(GLAB_NOT_FOUND_MESSAGE).toContain('PATH');
    expect(GLAB_NOT_FOUND_MESSAGE).toContain('~/.local/bin/glab');
    expect(GLAB_NOT_FOUND_MESSAGE).toContain('/opt/homebrew/bin/glab');
    expect(GLAB_NOT_FOUND_MESSAGE).toContain('/usr/local/bin/glab');
    expect(GLAB_NOT_FOUND_MESSAGE).toContain('CODIFF_GLAB_PATH=/absolute/path/to/glab');
  });

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

  test('parses concatenated JSON arrays from paginated glab output', () => {
    expect(
      parseGlabJsonPages('[{"id":1,"body":"brackets ][ inside strings"}][{"id":2}]\n[{"id":3}]'),
    ).toEqual([{ body: 'brackets ][ inside strings', id: 1 }, { id: 2 }, { id: 3 }]);
  });

  test('parses SSH remotes and preserves custom GitLab ports', () => {
    expect(parseRemoteUrl('ssh://git@gitlab.example.com:2222/group/project.git')).toEqual({
      host: 'gitlab.example.com:2222',
      projectPath: 'group/project',
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

  test('normalizes non-empty GitLab MR descriptions', () => {
    expect(
      createMergeRequestSource(
        {
          host: 'gitlab.example.com',
          number: 23,
          projectPath: 'group/project',
          url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
        },
        {
          author: {
            avatar_url: 'https://gitlab.example.com/avatar.png',
            username: 'mona',
            web_url: 'https://gitlab.example.com/mona',
          },
          description: '\n### Intent\n\nKeep the branch reviewable.\n',
          sha: 'head-sha',
          title: 'Reviewable branch',
          web_url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
        },
      ),
    ).toMatchObject({
      author: {
        avatarUrl: 'https://gitlab.example.com/avatar.png',
        login: 'mona',
        url: 'https://gitlab.example.com/mona',
      },
      description: '### Intent\n\nKeep the branch reviewable.',
      provider: 'gitlab',
      title: 'Reviewable branch',
      type: 'pull-request',
    });
  });

  test('omits blank GitLab MR descriptions', () => {
    expect(
      createMergeRequestSource(
        {
          host: 'gitlab.example.com',
          number: 23,
          projectPath: 'group/project',
          url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
        },
        { description: ' \n ' },
      ),
    ).not.toHaveProperty('description');
  });

  test('maps review outcomes to GitLab review quick actions', () => {
    expect(getGitLabReviewQuickAction('APPROVE')).toBe('/submit_review approve');
    expect(getGitLabReviewQuickAction('REQUEST_CHANGES')).toBe('/submit_review request_changes');
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

  test('maps unchanged lines and renamed paths for GitLab positions', () => {
    const diff = {
      diff: '@@ -10,3 +12,4 @@\n context\n-old\n+new\n added\n',
      new_path: 'src/new.ts',
      old_path: 'src/old.ts',
    };
    expect(createGitLabDiffLineMap(diff.diff).get('additions:12')).toEqual({
      newLine: 12,
      oldLine: 10,
    });
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
});
