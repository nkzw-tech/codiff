import { expect, test } from 'vite-plus/test';
import {
  commitRevisionLabel,
  diffComparison,
  diffRange,
  indexRevision,
  revisionRef,
  shaForRevision,
  versionRevisionLabel,
} from '../lib/review-history.ts';
import type { EvolutionUnitId, GitSha, ReviewVersionId } from '../types.ts';

const gitSha = (value: string) => value as GitSha;
const evolutionUnitId = (value: string) => value as EvolutionUnitId;
const reviewVersionId = (value: string) => value as ReviewVersionId;

test('keeps revision SHA identity separate from labels and non-commit markers', () => {
  const base = revisionRef(gitSha('a'.repeat(40)), commitRevisionLabel('base'));
  const head = revisionRef(gitSha('b'.repeat(40)), versionRevisionLabel('v1'));
  const comparison = diffComparison(diffRange(base, head), diffRange(base, head));

  expect(shaForRevision(base)).toBe(base.sha);
  expect(comparison.after.head.label.text).toBe('v1');
  expect(() => shaForRevision(indexRevision())).toThrow('Expected a commit revision');
  expect(reviewVersionId('version-1')).toBe('version-1');
  expect(evolutionUnitId('unit-1')).toBe('unit-1');
});
