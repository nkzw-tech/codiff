import { expect, test } from 'vite-plus/test';
import {
  createReviewCommandTarget,
  resolveReviewCommandTarget,
} from '../lib/review-command-target.ts';
import type { ChangedFile, ReviewSource } from '../types.ts';

const file = (path: string): ChangedFile => ({
  fingerprint: `${path}:1`,
  path,
  sections: [
    {
      binary: false,
      id: `${path}:unstaged`,
      kind: 'unstaged',
      patch: '',
    },
  ],
  status: 'modified',
});

test('review command target prefers active walkthrough target for the same source', () => {
  const source = { type: 'working-tree' } satisfies ReviewSource;
  const selectedFile = file('src/first.ts');
  const activeFile = file('src/current-walkthrough-hunk.ts');
  const activeTarget = createReviewCommandTarget(source, activeFile, {
    fingerprint: activeFile.fingerprint,
    key: 'walkthrough:active',
  });

  expect(
    resolveReviewCommandTarget({
      activeTarget,
      files: [selectedFile],
      selectedPath: selectedFile.path,
      source,
      useActiveTarget: true,
    }),
  ).toEqual(activeTarget);
});

test('review command target falls back to selected path outside active walkthrough routing', () => {
  const source = { type: 'working-tree' } satisfies ReviewSource;
  const selectedFile = file('src/first.ts');
  const activeFile = file('src/current-walkthrough-hunk.ts');

  const target = resolveReviewCommandTarget({
    activeTarget: createReviewCommandTarget(source, activeFile),
    files: [selectedFile],
    selectedPath: selectedFile.path,
    source,
    useActiveTarget: false,
  });

  expect(target?.file.path).toBe(selectedFile.path);
  expect(target?.reviewIdentity.key).toBe(selectedFile.path);
});

test('review command target ignores stale active target from another source', () => {
  const selectedFile = file('src/first.ts');
  const currentSource = { ref: 'HEAD', type: 'commit' } satisfies ReviewSource;
  const staleSource = { type: 'working-tree' } satisfies ReviewSource;

  const target = resolveReviewCommandTarget({
    activeTarget: createReviewCommandTarget(staleSource, file('src/stale.ts')),
    files: [selectedFile],
    selectedPath: selectedFile.path,
    source: currentSource,
    useActiveTarget: true,
  });

  expect(target?.file.path).toBe(selectedFile.path);
  expect(target?.sourceKey).toBe('commit:HEAD');
});
