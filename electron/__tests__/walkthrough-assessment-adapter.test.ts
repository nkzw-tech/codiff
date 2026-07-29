import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import { normalizeAssessmentInput } from '../../core/lib/walkthrough-assessments.ts';
import type { PullRequestExistingReviewComment } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const adapter =
  require('../walkthrough-assessment-adapter.cjs') as typeof import('../walkthrough-assessment-adapter.cjs');
const comment = (overrides: Partial<PullRequestExistingReviewComment> = {}) =>
  ({
    author: { login: 'reviewer' },
    body: 'Check this branch.',
    filePath: 'src/router.ts',
    id: 'comment-1',
    lineNumber: 12,
    side: 'additions',
    threadId: 'thread-1',
    ...overrides,
  }) satisfies PullRequestExistingReviewComment;

test('projects line and file threads without retaining presentation state', () => {
  const candidates = adapter.toAssessmentThreadCandidates(
    [
      comment({ isThreadResolved: true }),
      comment({ body: 'A reply.', filePath: '', id: 'comment-2', lineNumber: undefined }),
    ],
    { type: 'single-diff' },
    normalizeAssessmentInput,
  );
  const fileCandidate = adapter.toAssessmentThreadCandidates(
    [comment({ anchor: 'file', lineNumber: undefined, side: undefined })],
    { type: 'single-diff' },
    normalizeAssessmentInput,
  );

  expect(candidates[0]).toMatchObject({
    anchor: { endLine: 12, kind: 'line', path: 'src/router.ts', side: 'additions' },
    thread: { id: 'thread-1' },
  });
  expect(fileCandidate[0]).toMatchObject({
    anchor: { kind: 'file', path: 'src/router.ts' },
  });
  expect(JSON.stringify(candidates[0]?.thread)).not.toContain('isThreadResolved');
  expect(adapter.capturedThreadStateById([comment({ isThreadResolved: true })])).toEqual(
    new Map([['thread-1', 'resolved']]),
  );
});

test('materializes exact addition and deletion ranges from captured patches', () => {
  expect(
    adapter.toAssessmentChangedRanges([
      {
        fingerprint: 'file',
        oldPath: 'src/old.ts',
        path: 'src/new.ts',
        sections: [
          {
            binary: false,
            id: 'section',
            kind: 'pull-request',
            patch: '@@ -4,2 +10,3 @@\n-old\n+new',
          },
        ],
        status: 'renamed',
      },
    ]),
  ).toEqual([
    {
      endLine: 12,
      oldPath: 'src/old.ts',
      path: 'src/new.ts',
      side: 'additions',
      startLine: 10,
    },
    {
      endLine: 5,
      oldPath: 'src/old.ts',
      path: 'src/new.ts',
      side: 'deletions',
      startLine: 4,
    },
  ]);
});
