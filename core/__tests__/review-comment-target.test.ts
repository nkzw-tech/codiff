import { expect, test } from 'vite-plus/test';
import {
  resolveProviderCommentTarget,
  resolveShareCommentTarget,
} from '../lib/review-comment-target.ts';
import type { ChangedFile, DiffRange, GitSha } from '../types.ts';

const range = (base: string, head: string): DiffRange => ({
  base: {
    label: { kind: 'commit', text: base.slice(0, 7) },
    sha: base as GitSha,
  },
  head: {
    label: { kind: 'commit', text: head.slice(0, 7) },
    sha: head as GitSha,
  },
});

const file = (target: DiffRange): ChangedFile => ({
  fingerprint: 'src/a.ts',
  path: 'src/a.ts',
  sections: [
    {
      binary: false,
      id: 'src/a.ts:target',
      kind: 'pull-request',
      patch:
        'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      range: target,
    },
  ],
  status: 'modified',
});

test('enables an exact current-review line target', () => {
  const target = range('a'.repeat(40), 'b'.repeat(40));
  const displayed = file(target);
  expect(
    resolveProviderCommentTarget({
      canonicalFiles: [displayed],
      file: displayed,
      lineNumber: 1,
      section: displayed.sections[0],
      showWhitespace: false,
      side: 'additions',
    }),
  ).toEqual({ position: { range: target }, status: 'enabled' });
});

test('fails closed when the selected file is absent from the target diff', () => {
  const target = range('a'.repeat(40), 'b'.repeat(40));
  const displayed = file(target);
  expect(
    resolveProviderCommentTarget({
      anchor: 'file',
      canonicalFiles: [],
      file: displayed,
      section: displayed.sections[0],
      showWhitespace: false,
    }),
  ).toEqual({ reason: 'file-not-in-target', status: 'read-only' });
});

test('fails closed when the selected section has no immutable range', () => {
  const target = range('a'.repeat(40), 'b'.repeat(40));
  const displayed = file(target);
  expect(
    resolveProviderCommentTarget({
      anchor: 'file',
      canonicalFiles: [displayed],
      file: displayed,
      section: { ...displayed.sections[0]!, range: undefined },
      showWhitespace: false,
    }),
  ).toEqual({ reason: 'missing-target-range', status: 'read-only' });
});

test('fails closed when an inline anchor is absent from the canonical target', () => {
  const target = range('a'.repeat(40), 'b'.repeat(40));
  const displayed = file(target);
  expect(
    resolveProviderCommentTarget({
      canonicalFiles: [displayed],
      file: displayed,
      lineNumber: 99,
      section: displayed.sections[0],
      showWhitespace: false,
      side: 'additions',
    }),
  ).toEqual({ reason: 'anchor-not-in-target', status: 'read-only' });
});

test('validates cross-side range endpoints against their own sides', () => {
  const target = range('a'.repeat(40), 'b'.repeat(40));
  const displayed = file(target);
  expect(
    resolveProviderCommentTarget({
      canonicalFiles: [displayed],
      file: displayed,
      lineNumber: 1,
      section: displayed.sections[0],
      showWhitespace: false,
      side: 'additions',
      startLineNumber: 1,
      startSide: 'deletions',
    }),
  ).toEqual({ position: { range: target }, status: 'enabled' });
});

test('fails closed when active files contain ambiguous range evidence', () => {
  const target = range('a'.repeat(40), 'b'.repeat(40));
  const displayed = file(target);
  expect(
    resolveProviderCommentTarget({
      anchor: 'file',
      canonicalFiles: [displayed, { ...displayed, fingerprint: 'duplicate' }],
      file: displayed,
      section: displayed.sections[0],
      showWhitespace: false,
    }),
  ).toEqual({ reason: 'ambiguous-target-range', status: 'read-only' });
});

test('falls back to a legacy section ID for an unpositioned shared snapshot', () => {
  const target = range('a'.repeat(40), 'b'.repeat(40));
  const displayed = file(target);
  const section = { ...displayed.sections[0]!, range: undefined };
  const legacyFile = { ...displayed, sections: [section] };

  expect(
    resolveShareCommentTarget({
      anchor: 'file',
      displayedFiles: [legacyFile],
      file: legacyFile,
      section,
      showWhitespace: false,
    }),
  ).toEqual({ sectionId: section.id, status: 'enabled' });
});

test('accepts working-tree pseudo-revisions for shared snapshot positions', () => {
  const target: DiffRange = {
    base: { kind: 'index', label: { kind: 'review-marker', text: 'Index' } },
    head: {
      kind: 'working-copy',
      label: { kind: 'review-marker', text: 'Working copy' },
    },
  };
  const displayed = file(target);

  expect(
    resolveShareCommentTarget({
      displayedFiles: [displayed],
      file: displayed,
      lineNumber: 1,
      section: displayed.sections[0],
      showWhitespace: false,
      side: 'additions',
    }),
  ).toEqual({ position: { range: target }, status: 'enabled' });
});

test('rejects pseudo-revisions at the provider target boundary', () => {
  const target: DiffRange = {
    base: { kind: 'index', label: { kind: 'review-marker', text: 'Index' } },
    head: {
      kind: 'working-copy',
      label: { kind: 'review-marker', text: 'Working copy' },
    },
  };
  const displayed = file(target);

  expect(
    resolveProviderCommentTarget({
      anchor: 'file',
      canonicalFiles: [displayed],
      file: displayed,
      section: displayed.sections[0],
      showWhitespace: false,
    }),
  ).toEqual({ reason: 'non-commit-target', status: 'read-only' });
});
