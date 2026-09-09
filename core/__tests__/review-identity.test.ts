import { expect, test } from 'vite-plus/test';
import {
  getFileReviewIdentity,
  getWalkthroughReviewIdentity,
  isReviewIdentityViewed,
  updateReviewIdentityViewed,
} from '../lib/review-identity.ts';
import { createChangedFile } from './helpers/fixtures.ts';

const file = createChangedFile('src/shared.ts', {
  patch: '@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-before\n+after\n',
});
const fileIdentity = getFileReviewIdentity(file);
const first = getWalkthroughReviewIdentity(file, [`${file.sections[0].id}:h1`]);
const second = getWalkthroughReviewIdentity(file, [`${file.sections[0].id}:h2`]);

test('all hunks must be viewed before the whole file is viewed', () => {
  let viewed = updateReviewIdentityViewed({}, first, false);
  expect(isReviewIdentityViewed(viewed, first)).toBe(true);
  expect(isReviewIdentityViewed(viewed, second)).toBe(false);
  expect(isReviewIdentityViewed(viewed, fileIdentity)).toBe(false);
  viewed = updateReviewIdentityViewed(viewed, second, false);
  expect(isReviewIdentityViewed(viewed, fileIdentity)).toBe(true);
  expect(isReviewIdentityViewed(viewed, first)).toBe(true);
});

test('unviewing a hunk splits a whole-file mark and preserves the other hunks', () => {
  let viewed = updateReviewIdentityViewed({}, fileIdentity, false);
  expect(isReviewIdentityViewed(viewed, first)).toBe(true);
  expect(isReviewIdentityViewed(viewed, second)).toBe(true);
  viewed = updateReviewIdentityViewed(viewed, first, true);
  expect(isReviewIdentityViewed(viewed, fileIdentity)).toBe(false);
  expect(isReviewIdentityViewed(viewed, first)).toBe(false);
  expect(isReviewIdentityViewed(viewed, second)).toBe(true);
  viewed = updateReviewIdentityViewed(viewed, first, false);
  expect(isReviewIdentityViewed(viewed, fileIdentity)).toBe(true);
  viewed = updateReviewIdentityViewed(viewed, fileIdentity, true);
  expect(isReviewIdentityViewed(viewed, first)).toBe(false);
  expect(isReviewIdentityViewed(viewed, second)).toBe(false);
});

test('hunk progress survives regrouping but does not apply to changed content', () => {
  const viewed = updateReviewIdentityViewed({}, first, false);
  const combined = getWalkthroughReviewIdentity(file, [
    ...first.coverage!.hunkIds,
    ...second.coverage!.hunkIds,
  ]);
  expect(isReviewIdentityViewed(viewed, combined)).toBe(false);
  expect(isReviewIdentityViewed(updateReviewIdentityViewed(viewed, second, false), combined)).toBe(
    true,
  );
  expect(
    isReviewIdentityViewed(
      viewed,
      getWalkthroughReviewIdentity({ ...file, fingerprint: 'changed' }, first.coverage!.hunkIds),
    ),
  ).toBe(false);
});

test('all sections count toward completion, including synthetic generated hunks', () => {
  const generated = {
    ...file,
    generated: true,
    sections: [
      ...file.sections,
      { ...file.sections[0], id: 'src/shared.ts:staged', kind: 'staged' as const },
    ],
  };
  const unstaged = getWalkthroughReviewIdentity(generated, [`${generated.sections[0].id}:h1`]);
  const staged = getWalkthroughReviewIdentity(generated, [`${generated.sections[1].id}:h1`]);
  let viewed = updateReviewIdentityViewed({}, unstaged, false);
  expect(isReviewIdentityViewed(viewed, getFileReviewIdentity(generated))).toBe(false);
  viewed = updateReviewIdentityViewed(viewed, staged, false);
  expect(isReviewIdentityViewed(viewed, getFileReviewIdentity(generated))).toBe(true);
});
