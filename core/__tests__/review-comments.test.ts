import { expect, test } from 'vite-plus/test';
import type {
  ProviderCommentDraft,
  ProviderInlineComment,
  ShareCommentDraft,
} from '../lib/app-types.ts';
import {
  findReusableReviewCommentDraft,
  getPendingPullRequestReviewComments,
  getReviewCommentsFromState,
  getVisibleReviewComments,
  mergeReviewComments,
  resolveReviewCommentSection,
  toProviderCommentSubmission,
  toProviderSubmittedReviewComment,
  toPullRequestExistingReviewComment,
  toRenderedSubmittedReviewComment,
  toShareCommentSubmission,
} from '../lib/review-comments.ts';
import type { GitSha, RepositoryState } from '../types.ts';

const providerPosition = {
  range: {
    base: { label: { kind: 'commit' as const, text: 'base' }, sha: 'a'.repeat(40) as GitSha },
    head: { label: { kind: 'commit' as const, text: 'head' }, sha: 'b'.repeat(40) as GitSha },
  },
};

const createProviderDraft = (
  overrides: Partial<ProviderCommentDraft> = {},
): ProviderCommentDraft => ({
  body: 'A comment.',
  filePath: 'src/a.ts',
  id: 'github:1',
  kind: 'provider-draft',
  lineNumber: 5,
  position: providerPosition,
  sectionId: 'src/a.ts:pull-request:1',
  side: 'additions',
  ...overrides,
});

const createShareDraft = (overrides: Partial<ShareCommentDraft> = {}): ShareCommentDraft => ({
  body: 'A shared comment.',
  filePath: 'src/a.ts',
  id: 'share:1',
  kind: 'share-draft',
  lineNumber: 5,
  sectionId: 'src/a.ts:unstaged',
  side: 'additions',
  ...overrides,
});

const createProviderComment = (
  overrides: Partial<ProviderInlineComment> = {},
): ProviderInlineComment => ({
  author: { login: 'reviewer' },
  body: 'A provider comment.',
  destination: 'provider',
  filePath: 'src/a.ts',
  id: 'github:remote',
  isReadOnly: true,
  kind: 'submitted-comment',
  lineNumber: 5,
  position: providerPosition,
  resolvedSectionId: 'src/a.ts:pull-request:1',
  side: 'additions',
  ...overrides,
});

const createPullRequestState = (): RepositoryState => ({
  branch: null,
  files: [
    {
      fingerprint: 'fingerprint',
      path: 'src/a.ts',
      sections: [
        {
          binary: false,
          id: 'src/a.ts:pull-request:1',
          kind: 'pull-request',
          patch:
            'diff --git a/src/a.ts b/src/a.ts\n@@ -1,6 +1,6 @@\n one\n two\n three\n four\n five\n six\n',
          range: providerPosition.range,
        },
      ],
      status: 'modified',
    },
  ],
  generatedAt: 0,
  launchPath: '/repo',
  reviewComments: [
    {
      author: { login: 'reviewer' },
      body: 'Outdated comment.',
      filePath: 'src/a.ts',
      id: 'github:1',
      isOutdated: true,
      lineNumber: 5,
      position: providerPosition,
      side: 'additions',
    },
    {
      author: { login: 'reviewer' },
      body: 'Current comment.',
      filePath: 'src/a.ts',
      id: 'github:2',
      lineNumber: 6,
      position: providerPosition,
      side: 'additions',
    },
  ],
  root: '/repo',
  source: {
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/1',
  },
});

test('getReviewCommentsFromState carries the outdated flag through to review comments', () => {
  const comments = getReviewCommentsFromState(createPullRequestState());

  expect(comments).toHaveLength(2);
  expect(
    comments.every(
      (comment) => comment.kind === 'submitted-comment' && comment.destination === 'provider',
    ),
  ).toBe(true);
  expect(comments.find((comment) => comment.id === 'github:1')?.isOutdated).toBe(true);
  expect(comments.find((comment) => comment.id === 'github:2')?.isOutdated).toBeUndefined();
});

test('retains unresolved provider comments with their original persisted coordinates', () => {
  const state = createPullRequestState();
  state.reviewComments = [
    {
      author: { login: 'reviewer' },
      body: 'The original line is no longer present.',
      canDelete: true,
      canEdit: true,
      filePath: 'src/a.ts',
      id: 'github:unresolved',
      isOutdated: true,
      lineNumber: 999,
      position: providerPosition,
      side: 'additions',
      submittedAt: '2026-08-01T00:00:00.000Z',
      threadId: 'thread-unresolved',
      url: 'https://github.com/example/repo/pull/1#discussion_r1',
    },
  ];

  const comments = getReviewCommentsFromState(state);
  expect(comments).toEqual([
    expect.objectContaining({
      body: 'The original line is no longer present.',
      canDelete: true,
      canEdit: true,
      destination: 'provider',
      filePath: 'src/a.ts',
      id: 'github:unresolved',
      isOutdated: true,
      lineNumber: 999,
      position: providerPosition,
      threadId: 'thread-unresolved',
      url: 'https://github.com/example/repo/pull/1#discussion_r1',
    }),
  ]);
  expect(comments[0]).not.toHaveProperty('resolvedSectionId');
  expect(getVisibleReviewComments(comments, false)).toEqual([]);
  expect(getVisibleReviewComments(comments, true)).toEqual(comments);
});

test('getReviewCommentsFromState derives a working-tree section from line coordinates', () => {
  const state = createPullRequestState();
  state.source = { type: 'working-tree' };
  state.files = [
    {
      ...state.files[0]!,
      sections: [
        {
          binary: false,
          id: 'src/a.ts:staged',
          kind: 'staged',
          patch:
            'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
        },
        {
          binary: false,
          id: 'src/a.ts:unstaged',
          kind: 'unstaged',
          patch:
            'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5 +5 @@\n-old\n+new',
        },
      ],
    },
  ];
  state.reviewComments = [
    {
      author: { login: 'reviewer' },
      body: 'Persist this shared walkthrough comment.',
      filePath: 'src/a.ts',
      id: 'shared:1',
      lineNumber: 5,
      sectionId: 'src/a.ts:unstaged',
      side: 'additions',
    },
  ];

  expect(getReviewCommentsFromState(state, 'share')).toEqual([
    expect.objectContaining({
      body: 'Persist this shared walkthrough comment.',
      destination: 'share',
      id: 'shared:1',
      isReadOnly: true,
      resolvedSectionId: 'src/a.ts:unstaged',
      sectionId: 'src/a.ts:unstaged',
    }),
  ]);
});

test('getReviewCommentsFromState prefers a persisted range over matching line coordinates', () => {
  const state = createPullRequestState();
  state.source = { type: 'working-tree' };
  const head = {
    label: { kind: 'commit' as const, text: 'current-head' },
    sha: 'a'.repeat(40) as GitSha,
  };
  const index = {
    kind: 'index' as const,
    label: { kind: 'review-marker' as const, text: 'Index' },
  };
  const workingCopy = {
    kind: 'working-copy' as const,
    label: { kind: 'review-marker' as const, text: 'Working copy' },
  };
  state.files = [
    {
      ...state.files[0]!,
      sections: [
        {
          binary: false,
          id: 'src/a.ts:staged',
          kind: 'staged',
          patch:
            'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5 +5 @@\n-old\n+staged',
          range: { base: head, head: index },
        },
        {
          binary: false,
          id: 'src/a.ts:unstaged',
          kind: 'unstaged',
          patch:
            'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5 +5 @@\n-staged\n+unstaged',
          range: { base: index, head: workingCopy },
        },
      ],
    },
  ];
  const persistedIndex = {
    ...index,
    label: { kind: 'review-marker' as const, text: 'Persisted index label' },
  };
  const persistedWorkingCopy = {
    ...workingCopy,
    label: { kind: 'review-marker' as const, text: 'Persisted working copy label' },
  };
  state.reviewComments = [
    {
      author: { login: 'reviewer' },
      body: 'Keep this unstaged.',
      filePath: 'src/a.ts',
      id: 'shared:range',
      lineNumber: 5,
      position: { range: { base: persistedIndex, head: persistedWorkingCopy } },
      side: 'additions',
    },
  ];

  expect(getReviewCommentsFromState(state, 'share')).toEqual([
    expect.objectContaining({
      destination: 'share',
      id: 'shared:range',
      position: { range: { base: persistedIndex, head: persistedWorkingCopy } },
      resolvedSectionId: 'src/a.ts:unstaged',
    }),
  ]);
});

test('getPendingPullRequestReviewComments includes an unflushed active draft', () => {
  const comments = [
    createProviderDraft({ body: '', id: 'draft' }),
    createProviderDraft({ body: 'Already flushed.', id: 'ready', lineNumber: 6 }),
  ];

  expect(
    getPendingPullRequestReviewComments(comments, {
      ...comments[0],
      body: 'Still focused.',
    }).map((comment) => [comment.id, comment.body]),
  ).toEqual([
    ['draft', 'Still focused.'],
    ['ready', 'Already flushed.'],
  ]);
});

test('getPendingPullRequestReviewComments replaces a stale flushed draft', () => {
  const comments = [createProviderDraft({ body: 'Old text.', id: 'draft' })];

  expect(
    getPendingPullRequestReviewComments(comments, {
      ...comments[0],
      body: 'New text.',
    }).map((comment) => comment.body),
  ).toEqual(['New text.']);
});

test('getPendingPullRequestReviewComments respects an emptied active draft', () => {
  const comments = [createProviderDraft({ body: 'Old text.', id: 'draft' })];

  expect(
    getPendingPullRequestReviewComments(comments, {
      body: '   ',
      id: comments[0].id,
    }),
  ).toEqual([]);
});

test('getPendingPullRequestReviewComments ignores drafts outside the current review', () => {
  expect(
    getPendingPullRequestReviewComments([], {
      body: 'Stale text.',
      id: 'stale-draft',
    }),
  ).toEqual([]);
});

test('getPendingPullRequestReviewComments excludes comments being submitted individually', () => {
  const comment = createProviderDraft({ body: 'Already submitting.', id: 'draft' });

  expect(
    getPendingPullRequestReviewComments([{ ...comment, remoteSubmit: { status: 'submitting' } }]),
  ).toEqual([]);
});

test('findReusableReviewCommentDraft preserves an active draft with unflushed content', () => {
  const activeDraft = createProviderDraft({ body: '', id: 'active' });
  const reusableDraft = createProviderDraft({ body: '', id: 'reusable', lineNumber: 6 });

  expect(
    findReusableReviewCommentDraft([activeDraft, reusableDraft], {
      body: 'Still typing.',
      id: activeDraft.id,
    }),
  ).toBe(reusableDraft);
});

test('findReusableReviewCommentDraft returns no draft when the only empty draft has content', () => {
  const activeDraft = createProviderDraft({ body: '', id: 'active' });

  expect(
    findReusableReviewCommentDraft([activeDraft], {
      body: 'Still typing.',
      id: activeDraft.id,
    }),
  ).toBeUndefined();
});

test('findReusableReviewCommentDraft reuses whitespace-only provider drafts', () => {
  const activeDraft = createProviderDraft({ body: '', id: 'active' });

  expect(
    findReusableReviewCommentDraft([activeDraft], {
      body: '   ',
      id: activeDraft.id,
    }),
  ).toBe(activeDraft);
});

test('getReviewCommentsFromState carries GitLab discussion metadata through to review comments', () => {
  const state = createPullRequestState();
  state.reviewComments = [
    {
      author: { login: 'reviewer' },
      body: 'Resolvable comment.',
      canResolveThread: true,
      filePath: 'src/a.ts',
      id: 'gitlab:1',
      lineNumber: 5,
      side: 'additions',
      threadId: 'discussion-1',
    },
    {
      author: { login: 'reviewer' },
      body: 'Resolved comment.',
      filePath: 'src/a.ts',
      id: 'gitlab:2',
      isThreadResolved: true,
      lineNumber: 6,
      side: 'additions',
      threadId: 'discussion-2',
    },
  ];
  const comments = getReviewCommentsFromState(state);

  expect(comments.find((comment) => comment.id === 'gitlab:1')).toMatchObject({
    canResolveThread: true,
    threadId: 'discussion-1',
  });
  expect(comments.find((comment) => comment.id === 'gitlab:2')).toMatchObject({
    isThreadResolved: true,
    threadId: 'discussion-2',
  });
});

test('getReviewCommentsFromState preserves file-level GitLab anchors', () => {
  const state = createPullRequestState();
  state.reviewComments = [
    {
      anchor: 'file',
      author: { login: 'reviewer' },
      body: 'Review the file as a whole.',
      filePath: 'src/a.ts',
      id: 'gitlab:file',
      position: providerPosition,
    },
  ];

  expect(getReviewCommentsFromState(state)).toEqual([
    expect.objectContaining({
      anchor: 'file',
      body: 'Review the file as a whole.',
      filePath: 'src/a.ts',
      id: 'gitlab:file',
      isReadOnly: true,
      position: providerPosition,
      resolvedSectionId: 'src/a.ts:pull-request:1',
    }),
  ]);
});

test('getVisibleReviewComments hides outdated comments unless they are shown', () => {
  const comments = [
    createProviderComment({ id: 'github:1', isOutdated: true }),
    createProviderComment({ id: 'github:2' }),
  ];

  expect(getVisibleReviewComments(comments, false).map((comment) => comment.id)).toEqual([
    'github:2',
  ]);
  expect(getVisibleReviewComments(comments, true).map((comment) => comment.id)).toEqual([
    'github:1',
    'github:2',
  ]);
});

test('getVisibleReviewComments keeps user-authored comments that are never outdated', () => {
  const comments = [createProviderDraft({ id: 'draft' })];

  expect(getVisibleReviewComments(comments, false)).toHaveLength(1);
});

test('serializes provider replies without requiring position metadata', () => {
  const submission = toProviderCommentSubmission(
    createProviderDraft({
      anchor: 'file',
      body: 'Reply in the existing discussion.',
      lineNumber: undefined,
      position: undefined,
      side: undefined,
      threadId: 'discussion-1',
    }),
  );

  expect(submission).toEqual({
    anchor: 'file',
    body: 'Reply in the existing discussion.',
    filePath: 'src/a.ts',
    localDraftId: 'github:1',
    threadId: 'discussion-1',
  });
  expect(
    toProviderSubmittedReviewComment(
      {
        author: { login: 'reviewer' },
        body: submission.body,
        filePath: submission.filePath,
        id: 'github:reply',
        threadId: submission.threadId,
      },
      submission,
    ),
  ).not.toHaveProperty('position');
});

test('omits UI-only section identity but preserves exact provider positions', () => {
  const position = {
    range: {
      base: { label: { kind: 'commit' as const, text: 'a' }, sha: 'a'.repeat(40) as GitSha },
      head: { label: { kind: 'commit' as const, text: 'b' }, sha: 'b'.repeat(40) as GitSha },
    },
  };
  const comment = createProviderDraft({ body: 'Persist this comment.', position });

  expect(toProviderCommentSubmission(comment)).not.toHaveProperty('sectionId');
  expect(toProviderCommentSubmission(comment)).toMatchObject({
    localDraftId: comment.id,
    position,
  });
});

test('rejects provider submissions that contain pseudo-revisions', () => {
  const comment = createProviderDraft();
  const invalid = {
    ...comment,
    position: {
      range: {
        base: { kind: 'index' as const, label: { kind: 'review-marker' as const, text: 'Index' } },
        head: {
          kind: 'working-copy' as const,
          label: { kind: 'review-marker' as const, text: 'Working copy' },
        },
      },
    },
  } as unknown as ProviderCommentDraft;

  expect(() => toProviderCommentSubmission(invalid)).toThrow(
    'Provider comments require an exact immutable commit position.',
  );
});

test('reports ambiguous persisted ranges instead of selecting an arbitrary section', () => {
  const state = createPullRequestState();
  const position = {
    range: {
      base: { label: { kind: 'commit' as const, text: 'a' }, sha: 'a'.repeat(40) as GitSha },
      head: { label: { kind: 'commit' as const, text: 'b' }, sha: 'b'.repeat(40) as GitSha },
    },
  };
  state.files[0]!.sections = [
    { ...state.files[0]!.sections[0]!, id: 'first', range: position.range },
    { ...state.files[0]!.sections[0]!, id: 'second', range: position.range },
  ];
  const comment = { ...state.reviewComments![0]!, position };

  expect(resolveReviewCommentSection(state.files[0]!, comment, false)).toEqual({
    candidateSectionIds: ['first', 'second'],
    kind: 'ambiguous',
    strategy: 'position',
  });
});

test('uses durable positions and preserves section IDs only for legacy shared comments', () => {
  const legacy = createShareDraft({ sectionId: 'src/a.ts:unstaged' });
  expect(toShareCommentSubmission(legacy)).toMatchObject({
    sectionId: 'src/a.ts:unstaged',
  });

  const positioned = {
    ...legacy,
    position: {
      range: {
        base: { label: { kind: 'commit' as const, text: 'a' }, sha: 'a'.repeat(40) as GitSha },
        head: { label: { kind: 'commit' as const, text: 'b' }, sha: 'b'.repeat(40) as GitSha },
      },
    },
  };
  expect(toShareCommentSubmission(positioned)).toMatchObject({
    position: positioned.position,
  });
  expect(toShareCommentSubmission(positioned)).not.toHaveProperty('sectionId');
});

test('accepts index and working-copy revisions in shared comment positions', () => {
  const position = {
    range: {
      base: { kind: 'index' as const, label: { kind: 'review-marker' as const, text: 'Index' } },
      head: {
        kind: 'working-copy' as const,
        label: { kind: 'review-marker' as const, text: 'Working copy' },
      },
    },
  };

  expect(toShareCommentSubmission(createShareDraft({ position }))).toMatchObject({ position });
});

test('converts submitted drafts into provider comments with durable positions', () => {
  const position = {
    range: {
      base: { label: { kind: 'commit' as const, text: 'a' }, sha: 'a'.repeat(40) as GitSha },
      head: { label: { kind: 'commit' as const, text: 'b' }, sha: 'b'.repeat(40) as GitSha },
    },
  };
  const draft = createProviderDraft({
    id: 'draft-comment',
    position,
    remoteSubmit: { status: 'submitting' },
  });
  const submission = toProviderCommentSubmission(draft);
  const submitted = toRenderedSubmittedReviewComment(
    toProviderSubmittedReviewComment(
      {
        author: { login: 'ada', name: 'Ada Lovelace' },
        body: draft.body,
        canDelete: true,
        canEdit: true,
        filePath: draft.filePath,
        id: 'persisted-comment',
        lineNumber: draft.lineNumber,
        side: draft.side,
        submittedAt: '2026-07-16T12:00:00.000Z',
        threadId: 'persisted-thread',
      },
      submission,
    ),
    draft,
  );

  expect(submitted.position).toEqual(position);
  expect(submitted.destination).toBe('provider');
  expect(submitted.resolvedSectionId).toBe(draft.sectionId);
  expect(mergeReviewComments([submitted], [])).toEqual([submitted]);

  const snapshotComment = { ...submitted, body: 'Canonical server comment.' };
  expect(mergeReviewComments([snapshotComment], [])).toEqual([snapshotComment]);
});

test('round trips provider and share provenance independently', () => {
  const providerComment = createProviderComment();
  const providerState = createPullRequestState();
  providerState.reviewComments = [toPullRequestExistingReviewComment(providerComment)];
  expect(getReviewCommentsFromState(providerState)[0]).toMatchObject({
    destination: 'provider',
    position: providerPosition,
  });
  expect(getReviewCommentsFromState(providerState)[0]).not.toHaveProperty('sectionId');

  const shareComment = {
    author: { login: 'ada' },
    body: 'Legacy shared feedback.',
    destination: 'share' as const,
    filePath: 'src/a.ts',
    id: 'share:submitted',
    isReadOnly: true as const,
    kind: 'submitted-comment' as const,
    lineNumber: 5,
    resolvedSectionId: 'src/a.ts:pull-request:1',
    sectionId: 'src/a.ts:pull-request:1',
    side: 'additions' as const,
  };
  const shareState = createPullRequestState();
  shareState.reviewComments = [toPullRequestExistingReviewComment(shareComment)];
  expect(getReviewCommentsFromState(shareState, 'share')[0]).toMatchObject({
    destination: 'share',
    sectionId: 'src/a.ts:pull-request:1',
  });
});
