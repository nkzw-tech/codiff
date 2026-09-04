import { expect, test } from 'vite-plus/test';
import { reviewCommentPositionSchema } from './review-position.ts';

const commit = (sha: string) => ({
  label: { kind: 'commit' as const, text: sha },
  sha,
});

test('accepts durable commit, index, and working-copy review coordinates', () => {
  for (const range of [
    { base: commit('a'.repeat(40)), head: commit('b'.repeat(40)) },
    { base: null, head: commit('b'.repeat(40)) },
    {
      base: { kind: 'index' as const, label: { kind: 'review-marker' as const, text: 'Index' } },
      head: {
        kind: 'working-copy' as const,
        label: { kind: 'review-marker' as const, text: 'Working copy' },
      },
    },
  ]) {
    expect(reviewCommentPositionSchema.safeParse({ range }).success).toBe(true);
  }
});

test('rejects malformed or expanded review coordinates', () => {
  expect(reviewCommentPositionSchema.safeParse({ range: { base: {}, head: {} } }).success).toBe(
    false,
  );
  expect(
    reviewCommentPositionSchema.safeParse({
      range: { base: commit('a'), head: commit('b') },
      unexpected: true,
    }).success,
  ).toBe(false);
});
