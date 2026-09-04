import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';
import type {
  GitSha,
  SubmitPullRequestCommentRequest,
  SubmitPullRequestReviewRequest,
} from '../../core/types.ts';
import { createTemporaryGitRepository } from './helpers/git-repository.ts';

const require = createRequire(import.meta.url);
const { createGitHubReviewMutations } = require('../git-state/github-review-mutations.cjs') as {
  createGitHubReviewMutations: (dependencies: Record<string, unknown>) => {
    submitPullRequestComment: (
      launchPath: string,
      request: SubmitPullRequestCommentRequest,
    ) => Promise<unknown>;
    submitPullRequestReview: (
      launchPath: string,
      request: SubmitPullRequestReviewRequest,
    ) => Promise<unknown>;
  };
};

const baseSha = 'a'.repeat(40) as GitSha;
const headSha = 'b'.repeat(40) as GitSha;
const source = {
  headSha,
  provider: 'github' as const,
  type: 'pull-request' as const,
  url: 'https://github.com/nkzw-tech/codiff/pull/12',
};
const comment = {
  body: 'Please keep this explicit.',
  filePath: 'src/app.ts',
  lineNumber: 7,
  localDraftId: 'draft-1',
  position: {
    range: {
      base: { label: { kind: 'commit' as const, text: 'aaaaaaa' }, sha: baseSha },
      head: { label: { kind: 'commit' as const, text: 'bbbbbbb' }, sha: headSha },
    },
  },
  side: 'additions' as const,
};

const createHarness = () => {
  const request = vi.fn(async () => ({}));
  const mutations = createGitHubReviewMutations({
    assertPullRequestMatchesRepository: async () => undefined,
    createTransport: () => ({ request }),
    normalizeGitHubReviewComment: (value: Record<string, unknown>) =>
      value.id
        ? {
            author: { login: 'reviewer' },
            body: String(value.body || ''),
            filePath: String(value.path || 'src/app.ts'),
            id: `github:${String(value.id)}`,
            lineNumber: Number(value.line || 7),
            side: 'additions',
            threadId: String(value.in_reply_to_id || value.id),
          }
        : null,
    parseGitHubPullRequestUrl: () => ({
      number: 12,
      owner: 'nkzw-tech',
      repo: 'codiff',
      url: source.url,
    }),
    readCurrentTarget: async () => ({
      baseSha,
      files: [{ newPath: 'src/app.ts', patch: '@@ -7 +7 @@\n-old\n+new\n' }],
      headSha,
    }),
  });
  return { mutations, request };
};

test('submits GitHub replies with provider thread identity only', async () => {
  await using repository = await createTemporaryGitRepository('codiff-github-mutation-');
  const { mutations, request } = createHarness();
  request.mockResolvedValueOnce({
    body: 'Reply in the existing thread.',
    id: 8,
    in_reply_to_id: 7,
    line: 7,
    path: 'src/app.ts',
  });

  await expect(
    mutations.submitPullRequestComment(repository.path, {
      comment: {
        body: 'Reply in the existing thread.',
        filePath: 'src/app.ts',
        localDraftId: 'reply-draft',
        threadId: '7',
      },
      source,
    }),
  ).resolves.toMatchObject({ id: 'github:8', threadId: '7' });
  expect(request).toHaveBeenCalledWith({
    body: { body: 'Reply in the existing thread.', in_reply_to: 7 },
    method: 'POST',
    path: 'repos/nkzw-tech/codiff/pulls/12/comments',
  });
});

test('submits a review against the exact validated GitHub head', async () => {
  await using repository = await createTemporaryGitRepository('codiff-github-mutation-');
  const { mutations, request } = createHarness();

  await expect(
    mutations.submitPullRequestReview(repository.path, {
      comments: [comment],
      event: 'COMMENT',
      source,
    }),
  ).resolves.toEqual({ status: 'submitted', submittedDraftIds: ['draft-1'] });
  expect(request).toHaveBeenCalledWith({
    body: {
      body: 'Review comments.',
      comments: [
        {
          body: comment.body,
          line: 7,
          path: 'src/app.ts',
          side: 'RIGHT',
        },
      ],
      commit_id: headSha,
      event: 'COMMENT',
    },
    method: 'POST',
    path: 'repos/nkzw-tech/codiff/pulls/12/reviews',
  });
});

test('rejects a stale GitHub range before mutating the provider', async () => {
  await using repository = await createTemporaryGitRepository('codiff-github-mutation-');
  const { mutations, request } = createHarness();
  const stale = {
    ...comment,
    position: {
      range: {
        ...comment.position.range,
        head: { ...comment.position.range.head, sha: 'c'.repeat(40) as GitSha },
      },
    },
  };

  await expect(
    mutations.submitPullRequestReview(repository.path, {
      comments: [stale],
      event: 'COMMENT',
      source,
    }),
  ).resolves.toMatchObject({
    reason: expect.stringContaining('draft range no longer matches'),
    status: 'failed',
    submittedDraftIds: [],
  });
  expect(request).not.toHaveBeenCalled();
});

test('rejects a GitHub line absent from the fresh target diff', async () => {
  await using repository = await createTemporaryGitRepository('codiff-github-mutation-');
  const { mutations, request } = createHarness();

  await expect(
    mutations.submitPullRequestReview(repository.path, {
      comments: [{ ...comment, lineNumber: 99 }],
      event: 'COMMENT',
      source,
    }),
  ).resolves.toMatchObject({
    reason: expect.stringContaining('Line 99'),
    status: 'failed',
    submittedDraftIds: [],
  });
  expect(request).not.toHaveBeenCalled();
});

test.each(['APPROVE', 'REQUEST_CHANGES'] as const)(
  'batches GitHub inline comments and summary with the %s outcome',
  async (event) => {
    await using repository = await createTemporaryGitRepository('codiff-github-mutation-');
    const { mutations, request } = createHarness();

    await expect(
      mutations.submitPullRequestReview(repository.path, {
        body: 'Outcome summary.',
        comments: [comment],
        event,
        source,
      }),
    ).resolves.toEqual({ status: 'submitted', submittedDraftIds: ['draft-1'] });
    expect(request).toHaveBeenCalledWith({
      body: expect.objectContaining({
        body: 'Outcome summary.',
        commit_id: headSha,
        event,
      }),
      method: 'POST',
      path: 'repos/nkzw-tech/codiff/pulls/12/reviews',
    });
  },
);
