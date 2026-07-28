import { expect, test } from 'vite-plus/test';
import { diffRange, shaForRevision } from '../lib/review-history.ts';
import type { GitSha, Revision } from '../types.ts';

const gitSha = (value: string) => value as GitSha;

test('keeps revision SHA identity separate from labels and non-commit markers', () => {
  const base: Revision = {
    label: { kind: 'commit', text: 'base' },
    sha: gitSha('a'.repeat(40)),
  };
  const head: Revision = {
    label: { kind: 'commit', text: 'head' },
    sha: gitSha('b'.repeat(40)),
  };
  const range = diffRange(base, head);

  expect(shaForRevision(base)).toBe(base.sha);
  expect(range.head.label.text).toBe('head');
  expect(() =>
    shaForRevision({ kind: 'index', label: { kind: 'review-marker', text: 'Index' } }),
  ).toThrow('Expected a commit revision');
});
