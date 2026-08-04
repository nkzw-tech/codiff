import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';
import type {
  GitSha,
  SubmitPullRequestCommentRequest,
  SubmitPullRequestReviewRequest,
} from '../../core/types.ts';
import { createTemporaryGitRepository } from './helpers/git-repository.ts';

const require = createRequire(import.meta.url);
const { createGitLabReviewMutations } = require('../git-state/gitlab-review-mutations.cjs') as {
  createGitLabReviewMutations: (dependencies: Record<string, unknown>) => {
    submitMergeRequestComment: (
      launchPath: string,
      request: SubmitPullRequestCommentRequest,
    ) => Promise<unknown>;
    submitMergeRequestReview: (
      launchPath: string,
      request: SubmitPullRequestReviewRequest,
    ) => Promise<unknown>;
  };
};

const baseSha = 'a'.repeat(40) as GitSha;
const headSha = 'b'.repeat(40) as GitSha;
const source = {
  headSha,
  provider: 'gitlab' as const,
  type: 'pull-request' as const,
  url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
};
const comment = {
  body: 'Keep this explicit.',
  filePath: 'src/new.ts',
  lineNumber: 12,
  localDraftId: 'draft-1',
  position: {
    range: {
      base: { label: { kind: 'commit' as const, text: 'aaaaaaa' }, sha: baseSha },
      head: { label: { kind: 'commit' as const, text: 'bbbbbbb' }, sha: headSha },
    },
  },
  side: 'additions' as const,
};
const secondComment = {
  ...comment,
  body: 'Keep this second detail explicit.',
  localDraftId: 'draft-2',
};

type MutationRequest = { body?: unknown; method?: 'DELETE' | 'GET' | 'POST'; path: string };

const createHarness = ({
  failRequest,
  normalizeSubmittedGitLabReviewComment = () => null,
}: {
  failRequest?: (request: MutationRequest, index: number) => Error | undefined;
  normalizeSubmittedGitLabReviewComment?: (
    note: Record<string, unknown>,
    submittedComment: typeof comment,
    url: string,
    threadId?: string,
  ) => unknown;
} = {}) => {
  let nextRemoteDraftId = 1;
  let requestIndex = 0;
  const publishedDraftBatches: Array<ReadonlyArray<string>> = [];
  const remoteDrafts = new Map<string, string>();
  const request = vi.fn(async (nextRequest: MutationRequest) => {
    requestIndex += 1;
    const failure = failRequest?.(nextRequest, requestIndex);
    if (failure) {
      throw failure;
    }
    if (nextRequest.method === 'POST' && nextRequest.path.endsWith('/draft_notes')) {
      const id = String(nextRemoteDraftId);
      nextRemoteDraftId += 1;
      const note = (nextRequest.body as { note?: unknown } | undefined)?.note;
      remoteDrafts.set(id, typeof note === 'string' ? note : '');
      return { id };
    }
    if (nextRequest.method === 'DELETE') {
      const id = nextRequest.path.split('/').at(-1);
      if (id) remoteDrafts.delete(decodeURIComponent(id));
      return {};
    }
    if (
      nextRequest.method === 'POST' &&
      (nextRequest.path.endsWith('/draft_notes/bulk_publish') ||
        nextRequest.path.endsWith('/notes'))
    ) {
      publishedDraftBatches.push([...remoteDrafts.values()]);
      remoteDrafts.clear();
    }
    return {};
  });
  const readMergeRequestDiffs = vi.fn(async () => [
    {
      diff: '@@ -10,2 +12,2 @@\n context\n-old\n+new\n',
      new_path: 'src/new.ts',
      old_path: 'src/old.ts',
    },
  ]);
  const readMergeRequestMetadata = vi.fn(async () => ({
    diff_refs: { base_sha: baseSha, head_sha: headSha, start_sha: baseSha },
    sha: headSha,
  }));
  const mutations = createGitLabReviewMutations({
    createTransport: () => ({ request }),
    getDiscussionReplyEndpoint: () => '',
    mergeRequestEndpoint: (_mergeRequest: unknown, suffix = '') => `merge-request${suffix}`,
    normalizeSubmittedGitLabReviewComment,
    parseGitLabMergeRequestUrl: () => ({ url: source.url }),
    readMergeRequestDiffs,
    readMergeRequestMetadata,
    selectMergeRequestRemote: () => undefined,
  });
  return {
    mutations,
    publishedDraftBatches,
    readMergeRequestDiffs,
    readMergeRequestMetadata,
    remoteDrafts,
    request,
  };
};

const expectNoNeutralQuickAction = (
  calls: ReadonlyArray<readonly [MutationRequest, ...ReadonlyArray<unknown>]>,
) => {
  expect(calls.some(([nextRequest]) => nextRequest.path.endsWith('/notes'))).toBe(false);
  expect(JSON.stringify(calls)).not.toContain('/submit_review approve');
  expect(JSON.stringify(calls)).not.toContain('/submit_review request_changes');
};

test('returns the GitLab discussion identity for a newly submitted comment', async () => {
  await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
  const normalizeSubmittedGitLabReviewComment = vi.fn(
    (
      note: Record<string, unknown>,
      submittedComment: typeof comment,
      url: string,
      threadId?: string,
    ) => ({
      ...submittedComment,
      author: { login: 'reviewer' },
      id: `gitlab:${String(note.id)}`,
      threadId,
      url,
    }),
  );
  const { mutations, request } = createHarness({ normalizeSubmittedGitLabReviewComment });
  request.mockResolvedValueOnce({
    id: 'discussion-42',
    notes: [{ body: comment.body, id: 91 }],
  });

  await expect(
    mutations.submitMergeRequestComment(repository.path, { comment, source }),
  ).resolves.toMatchObject({ id: 'gitlab:91', threadId: 'discussion-42' });
  expect(normalizeSubmittedGitLabReviewComment).toHaveBeenCalledWith(
    expect.objectContaining({ id: 91 }),
    comment,
    source.url,
    'discussion-42',
  );
});

test('bulk-publishes an inline-only neutral GitLab review', async () => {
  await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
  const { mutations, request } = createHarness();

  await expect(
    mutations.submitMergeRequestReview(repository.path, {
      comments: [comment],
      event: 'COMMENT',
      source,
    }),
  ).resolves.toEqual({ status: 'submitted', submittedDraftIds: ['draft-1'] });
  expect(request).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ method: 'POST', path: 'merge-request/draft_notes' }),
  );
  expect(request).toHaveBeenNthCalledWith(2, {
    body: { reviewer_state: 'reviewed' },
    method: 'POST',
    path: 'merge-request/draft_notes/bulk_publish',
  });
  expectNoNeutralQuickAction(request.mock.calls);
});

test('includes the optional summary in neutral GitLab publication', async () => {
  await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
  const { mutations, request } = createHarness();

  await expect(
    mutations.submitMergeRequestReview(repository.path, {
      body: 'Review summary.',
      comments: [comment],
      event: 'COMMENT',
      source,
    }),
  ).resolves.toEqual({ status: 'submitted', submittedDraftIds: ['draft-1'] });
  expect(request).toHaveBeenLastCalledWith({
    body: { note: 'Review summary.', reviewer_state: 'reviewed' },
    method: 'POST',
    path: 'merge-request/draft_notes/bulk_publish',
  });
  expectNoNeutralQuickAction(request.mock.calls);
});

test('bulk-publishes a summary-only neutral GitLab review without a regular note', async () => {
  await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
  const { mutations, request } = createHarness();

  await expect(
    mutations.submitMergeRequestReview(repository.path, {
      body: 'Summary only.',
      comments: [],
      event: 'COMMENT',
      source,
    }),
  ).resolves.toEqual({ status: 'submitted', submittedDraftIds: [] });
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith({
    body: { note: 'Summary only.', reviewer_state: 'reviewed' },
    method: 'POST',
    path: 'merge-request/draft_notes/bulk_publish',
  });
  expectNoNeutralQuickAction(request.mock.calls);
});

test('rejects an empty neutral GitLab review before provider calls', async () => {
  await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
  const { mutations, readMergeRequestDiffs, readMergeRequestMetadata, request } = createHarness();

  await expect(
    mutations.submitMergeRequestReview(repository.path, {
      comments: [],
      event: 'COMMENT',
      source,
    }),
  ).resolves.toEqual({
    reason: 'A neutral review requires an inline comment or summary.',
    status: 'failed',
    submittedDraftIds: [],
  });
  expect(readMergeRequestMetadata).not.toHaveBeenCalled();
  expect(readMergeRequestDiffs).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

test('blocks retry when GitLab accepts a draft without returning its identity', async () => {
  await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
  const { mutations, request } = createHarness();
  request.mockImplementation(async ({ method, path }) => {
    if (method === 'POST' && path.endsWith('/draft_notes')) {
      return {};
    }
    return {};
  });

  await expect(
    mutations.submitMergeRequestReview(repository.path, {
      comments: [comment],
      event: 'COMMENT',
      source,
    }),
  ).resolves.toEqual({
    outcomeUnknownDraftIds: ['draft-1'],
    reason: 'GitLab accepted a draft note but did not return its ID.',
    status: 'failed',
    submittedDraftIds: [],
  });
});

test('removes accepted GitLab drafts when neutral publication fails', async () => {
  await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
  const { mutations, remoteDrafts, request } = createHarness({
    failRequest: ({ path }) =>
      path.endsWith('/draft_notes/bulk_publish')
        ? new Error('GitLab rejected bulk publication.')
        : undefined,
  });

  await expect(
    mutations.submitMergeRequestReview(repository.path, {
      comments: [comment],
      event: 'COMMENT',
      source,
    }),
  ).resolves.toEqual({
    reason: 'GitLab rejected bulk publication.',
    status: 'failed',
    submittedDraftIds: [],
  });
  expect(remoteDrafts.size).toBe(0);
  expect(request).toHaveBeenCalledWith({
    method: 'DELETE',
    path: 'merge-request/draft_notes/1',
  });
});

test('cleans partial GitLab drafts before retrying the review', async () => {
  await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
  let draftRequests = 0;
  const { mutations, publishedDraftBatches, remoteDrafts, request } = createHarness({
    failRequest: ({ method, path }) => {
      if (method !== 'POST' || !path.endsWith('/draft_notes')) {
        return undefined;
      }
      draftRequests += 1;
      return draftRequests === 2 ? new Error('GitLab rejected the second draft.') : undefined;
    },
  });
  const review = {
    comments: [comment, secondComment],
    event: 'COMMENT' as const,
    source,
  };

  await expect(mutations.submitMergeRequestReview(repository.path, review)).resolves.toEqual({
    outcomeUnknownDraftIds: ['draft-2'],
    reason: 'GitLab rejected the second draft.',
    status: 'failed',
    submittedDraftIds: [],
  });
  expect(remoteDrafts.size).toBe(0);
  expect(request).toHaveBeenCalledWith({
    method: 'DELETE',
    path: 'merge-request/draft_notes/1',
  });
  expect(
    request.mock.calls.some(([nextRequest]) =>
      nextRequest.path.endsWith('/draft_notes/bulk_publish'),
    ),
  ).toBe(false);

  await expect(mutations.submitMergeRequestReview(repository.path, review)).resolves.toEqual({
    status: 'submitted',
    submittedDraftIds: ['draft-1', 'draft-2'],
  });
  expect(publishedDraftBatches).toEqual([
    ['Keep this explicit.', 'Keep this second detail explicit.'],
  ]);
  expect(remoteDrafts.size).toBe(0);
});

test('reports remote draft ownership when GitLab cleanup also fails', async () => {
  await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
  const { mutations, remoteDrafts } = createHarness({
    failRequest: ({ method, path }) => {
      if (path.endsWith('/draft_notes/bulk_publish')) {
        return new Error('GitLab rejected bulk publication.');
      }
      return method === 'DELETE' ? new Error('GitLab rejected draft cleanup.') : undefined;
    },
  });

  await expect(
    mutations.submitMergeRequestReview(repository.path, {
      comments: [comment],
      event: 'COMMENT',
      source,
    }),
  ).resolves.toEqual({
    outcomeUnknownDraftIds: ['draft-1'],
    reason:
      'GitLab rejected bulk publication. GitLab draft cleanup also failed: GitLab rejected draft cleanup.',
    status: 'failed',
    submittedDraftIds: [],
  });
  expect([...remoteDrafts.values()]).toEqual(['Keep this explicit.']);
});

test.each(['APPROVE', 'REQUEST_CHANGES'] as const)(
  'keeps GitLab draft IDs unconfirmed when the final %s outcome fails',
  async (event) => {
    await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
    const { mutations } = createHarness({
      failRequest: ({ path }) =>
        path.endsWith('/notes') ? new Error('GitLab rejected the final outcome.') : undefined,
    });

    await expect(
      mutations.submitMergeRequestReview(repository.path, {
        comments: [comment],
        event,
        source,
      }),
    ).resolves.toEqual({
      reason: 'GitLab rejected the final outcome.',
      status: 'failed',
      submittedDraftIds: [],
    });
  },
);

test.each([
  ['APPROVE', '/submit_review approve'],
  ['REQUEST_CHANGES', '/submit_review request_changes'],
] as const)(
  'confirms all GitLab draft IDs after the final %s outcome succeeds',
  async (event, action) => {
    await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
    const { mutations, request } = createHarness();

    await expect(
      mutations.submitMergeRequestReview(repository.path, {
        body: 'Outcome summary.',
        comments: [comment, secondComment],
        event,
        source,
      }),
    ).resolves.toEqual({ status: 'submitted', submittedDraftIds: ['draft-1', 'draft-2'] });
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: 'POST', path: 'merge-request/draft_notes' }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: 'POST', path: 'merge-request/draft_notes' }),
    );
    expect(request).toHaveBeenNthCalledWith(3, {
      body: { body: `Outcome summary.\n\n${action}` },
      method: 'POST',
      path: 'merge-request/notes',
    });
  },
);

test('validates every GitLab draft before posting the first one', async () => {
  await using repository = await createTemporaryGitRepository('codiff-gitlab-mutation-');
  const { mutations, request } = createHarness();

  await expect(
    mutations.submitMergeRequestReview(repository.path, {
      comments: [comment, { ...comment, lineNumber: 99, localDraftId: 'draft-2' }],
      event: 'REQUEST_CHANGES',
      source,
    }),
  ).resolves.toMatchObject({
    reason: expect.stringContaining('Line 99'),
    status: 'failed',
    submittedDraftIds: [],
  });
  expect(request).not.toHaveBeenCalled();
});
