import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createPullRequestReviewPayload } = require('../git-state/pull-request.cjs') as {
  createPullRequestReviewPayload: (request: {
    body?: string;
    comments: ReadonlyArray<Record<string, unknown>>;
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
  }) => Record<string, unknown>;
};

test('builds a neutral GitHub review payload from inline comments', () => {
  expect(
    createPullRequestReviewPayload({
      comments: [
        {
          body: 'Please keep this explicit.',
          filePath: 'src/app.ts',
          lineNumber: 7,
          side: 'additions',
        },
      ],
      event: 'COMMENT',
    }),
  ).toEqual({
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
});

test('builds a neutral GitHub review payload from a trimmed review body', () => {
  expect(
    createPullRequestReviewPayload({
      body: '  General feedback.  ',
      comments: [],
      event: 'COMMENT',
    }),
  ).toEqual({ body: 'General feedback.', comments: [], event: 'COMMENT' });
});

test('rejects empty neutral GitHub reviews before calling GitHub', () => {
  expect(() =>
    createPullRequestReviewPayload({ body: '   ', comments: [], event: 'COMMENT' }),
  ).toThrow('A comment review requires an inline comment or a review comment.');
});

test('keeps the fallback body for an empty request-changes review', () => {
  expect(createPullRequestReviewPayload({ comments: [], event: 'REQUEST_CHANGES' })).toEqual({
    body: 'Requesting changes.',
    comments: [],
    event: 'REQUEST_CHANGES',
  });
});
