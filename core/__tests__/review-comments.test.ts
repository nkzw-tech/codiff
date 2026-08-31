import { expect, test } from 'vite-plus/test';
import type { ReviewComment } from '../lib/app-types.ts';
import {
  buildAgentReviewFeedback,
  findReusableReviewCommentDraft,
  getPendingPullRequestReviewComments,
  getReviewCommentsFromState,
  getVisibleReviewComments,
  mergeReviewComments,
  toSubmittedReviewComment,
  toPullRequestReviewComment,
} from '../lib/review-comments.ts';
import type { RepositoryState } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';

const createReviewComment = (overrides: Partial<ReviewComment>): ReviewComment => ({
  body: 'A comment.',
  filePath: 'src/a.ts',
  id: 'github:1',
  lineNumber: 5,
  sectionId: 'src/a.ts:pull-request:1',
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
          patch: '',
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
      side: 'additions',
    },
    {
      author: { login: 'reviewer' },
      body: 'Current comment.',
      filePath: 'src/a.ts',
      id: 'github:2',
      lineNumber: 6,
      side: 'additions',
    },
  ],
  root: '/repo',
  source: {
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/1',
  },
});

test('buildAgentReviewFeedback returns ordered structured comments and matching markdown', () => {
  const files = [createChangedFile('src/a.ts'), createChangedFile('src/b.ts')];
  const comments = [
    createReviewComment({
      body: '  Second file.  ',
      filePath: 'src/b.ts',
      id: 'b',
      lineNumber: 9,
      sectionId: files[1]!.sections[0]!.id,
    }),
    createReviewComment({
      body: 'First range.',
      filePath: 'src/a.ts',
      id: 'a',
      lineNumber: 7,
      startLineNumber: 5,
      startSide: 'deletions',
    }),
    createReviewComment({ body: 'Remote.', id: 'remote', isReadOnly: true }),
  ];

  const feedback = buildAgentReviewFeedback(files, comments, false, '# Fix these');

  expect(feedback.comments.map(({ body, filePath, order }) => ({ body, filePath, order }))).toEqual(
    [
      { body: 'First range.', filePath: 'src/a.ts', order: 1 },
      { body: 'Second file.', filePath: 'src/b.ts', order: 2 },
    ],
  );
  expect(feedback.comments[0]).toMatchObject({
    anchor: 'line',
    lineNumber: 7,
    startLineNumber: 5,
    startSide: 'deletions',
  });
  expect(feedback.markdown).toContain('# Fix these');
  expect(feedback.markdown.indexOf('src/a.ts')).toBeLessThan(feedback.markdown.indexOf('src/b.ts'));
  expect(feedback.markdown).toContain('First range.');
  expect(feedback.markdown).toContain('Second file.');
});

test('buildAgentReviewFeedback excludes empty and read-only comments', () => {
  const file = createChangedFile('src/a.ts');
  expect(
    buildAgentReviewFeedback(
      [file],
      [createReviewComment({ body: ' ' }), createReviewComment({ isReadOnly: true })],
      false,
      '',
    ),
  ).toEqual({ comments: [], markdown: '' });
});

test('getReviewCommentsFromState carries the outdated flag through to review comments', () => {
  const comments = getReviewCommentsFromState(createPullRequestState());

  expect(comments).toHaveLength(2);
  expect(comments.find((comment) => comment.id === 'github:1')?.isOutdated).toBe(true);
  expect(comments.find((comment) => comment.id === 'github:2')?.isOutdated).toBeUndefined();
});

test('getReviewCommentsFromState hydrates shared comments on their exact working-tree section', () => {
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
          patch: '',
        },
        {
          binary: false,
          id: 'src/a.ts:unstaged',
          kind: 'unstaged',
          patch: '',
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

  expect(getReviewCommentsFromState(state)).toEqual([
    expect.objectContaining({
      body: 'Persist this shared walkthrough comment.',
      id: 'shared:1',
      isReadOnly: true,
      sectionId: 'src/a.ts:unstaged',
    }),
  ]);
});

test('getPendingPullRequestReviewComments includes an unflushed active draft', () => {
  const comments = [
    createReviewComment({ body: '', id: 'draft' }),
    createReviewComment({ body: 'Already flushed.', id: 'ready', lineNumber: 6 }),
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
  const comments = [createReviewComment({ body: 'Old text.', id: 'draft' })];

  expect(
    getPendingPullRequestReviewComments(comments, {
      ...comments[0],
      body: 'New text.',
    }).map((comment) => comment.body),
  ).toEqual(['New text.']);
});

test('getPendingPullRequestReviewComments respects an emptied active draft', () => {
  const comments = [createReviewComment({ body: 'Old text.', id: 'draft' })];

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
  const comment = createReviewComment({ body: 'Already submitting.', id: 'draft' });

  expect(
    getPendingPullRequestReviewComments([{ ...comment, remoteSubmit: { status: 'submitting' } }]),
  ).toEqual([]);
});

test('findReusableReviewCommentDraft preserves an active draft with unflushed content', () => {
  const activeDraft = createReviewComment({ body: '', id: 'active' });
  const reusableDraft = createReviewComment({ body: '', id: 'reusable', lineNumber: 6 });

  expect(
    findReusableReviewCommentDraft([activeDraft, reusableDraft], {
      body: 'Still typing.',
      id: activeDraft.id,
    }),
  ).toBe(reusableDraft);
});

test('findReusableReviewCommentDraft returns no draft when the only empty draft has content', () => {
  const activeDraft = createReviewComment({ body: '', id: 'active' });

  expect(
    findReusableReviewCommentDraft([activeDraft], {
      body: 'Still typing.',
      id: activeDraft.id,
    }),
  ).toBeUndefined();
});

test('findReusableReviewCommentDraft skips read-only drafts and reuses whitespace-only drafts', () => {
  const readOnlyDraft = createReviewComment({ body: '', id: 'readonly', isReadOnly: true });
  const activeDraft = createReviewComment({ body: '', id: 'active' });

  expect(
    findReusableReviewCommentDraft([readOnlyDraft, activeDraft], {
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
    },
  ];

  expect(getReviewCommentsFromState(state)).toEqual([
    expect.objectContaining({
      anchor: 'file',
      body: 'Review the file as a whole.',
      filePath: 'src/a.ts',
      id: 'gitlab:file',
      isReadOnly: true,
      sectionId: 'src/a.ts:pull-request:1',
    }),
  ]);
});

test('getVisibleReviewComments hides outdated comments unless they are shown', () => {
  const comments = [
    createReviewComment({ id: 'github:1', isOutdated: true }),
    createReviewComment({ id: 'github:2' }),
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
  const comments = [createReviewComment({ id: 'draft', isReadOnly: false })];

  expect(getVisibleReviewComments(comments, false)).toHaveLength(1);
});

test('serializes file-level thread replies without inventing line metadata', () => {
  expect(
    toPullRequestReviewComment(
      createReviewComment({
        anchor: 'file',
        body: 'Reply in the existing discussion.',
        lineNumber: undefined,
        side: undefined,
        threadId: 'discussion-1',
      }),
    ),
  ).toEqual({
    anchor: 'file',
    body: 'Reply in the existing discussion.',
    filePath: 'src/a.ts',
    threadId: 'discussion-1',
  });
});

test('serializes section identity only for shared walkthrough comments', () => {
  const comment = createReviewComment({ body: 'Persist this comment.' });

  expect(toPullRequestReviewComment(comment)).not.toHaveProperty('sectionId');
  expect(toPullRequestReviewComment(comment, { includeSectionId: true })).toMatchObject({
    sectionId: 'src/a.ts:pull-request:1',
  });
});

test('keeps a submitted shared comment visible until the matching snapshot comment arrives', () => {
  const draft = createReviewComment({
    id: 'draft-comment',
    remoteSubmit: { status: 'submitting' },
  });
  const submitted = toSubmittedReviewComment(
    {
      author: { login: 'ada', name: 'Ada Lovelace' },
      body: draft.body,
      canDelete: true,
      canEdit: true,
      filePath: draft.filePath,
      id: 'persisted-comment',
      lineNumber: draft.lineNumber,
      sectionId: draft.sectionId,
      side: draft.side,
      submittedAt: '2026-07-16T12:00:00.000Z',
      threadId: 'persisted-thread',
    },
    draft,
  );

  expect(mergeReviewComments([], [submitted])).toEqual([submitted]);

  const snapshotComment = { ...submitted, body: 'Canonical server comment.' };
  expect(mergeReviewComments([snapshotComment], [submitted])).toEqual([snapshotComment]);
});
