import type { GitSha, ReviewVersionId } from '@nkzw/codiff-core/types';
import { expect, test } from 'vite-plus/test';
import {
  computeLineDiff,
  computeVersionComparePreferringReplay,
  type MergeRequestVersionRef,
  type VersionPatchFile,
} from '../src/version-compare.ts';

const gitSha = (value: string) => value as GitSha;
const reviewVersionId = (value: string) => value as ReviewVersionId;

const version = (id: string, headSha: string, baseSha: string): MergeRequestVersionRef => ({
  baseSha: gitSha(baseSha),
  createdAt: '2026-07-01T00:00:00.000Z',
  headSha: gitSha(headSha),
  label: `v${id}`,
  startSha: gitSha(baseSha),
  versionId: reviewVersionId(id),
});

const patchFile = (
  path: string,
  body: string,
  status: VersionPatchFile['status'] = 'modified',
): VersionPatchFile => ({
  newPath: path,
  oldPath: path,
  patchBody: body,
  status,
});

test('preferring replay uses regional replay when four endpoints are available', async () => {
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');
  const blobs = new Map<string, string>([
    ['base-a:src/app.ts', 'const value = 1;\nold();\n'],
    ['head-a:src/app.ts', 'const value = 1;\nnewCall();\n'],
    ['base-b:src/app.ts', 'const value = 1;\nold();\n'],
    ['head-b:src/app.ts', 'const value = 1;\nnewCall();\nguard();\n'],
  ]);
  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles: [
      patchFile('src/app.ts', '@@ -1,2 +1,2 @@\n const value = 1;\n-old();\n+newCall();\n'),
    ],
    readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
    to,
    toFiles: [
      patchFile(
        'src/app.ts',
        '@@ -1,2 +1,3 @@\n const value = 1;\n-old();\n+newCall();\n+guard();\n',
      ),
    ],
  });
  expect(result.algorithm).toBe('region-aware-replay');
  expect(result.summary.empty).toBe(false);
  expect(result.files[0]?.path).toBe('src/app.ts');
  // Expected Replay has newCall only; Later HEAD adds guard.
  expect(result.files[0]?.file.sections[0]?.patch).toContain('+guard();');
});

test('preferring replay reports unavailable endpoints as incomplete', async () => {
  const result = await computeVersionComparePreferringReplay({
    from: version('1', 'head-a', 'base-a'),
    fromFiles: [patchFile('src/app.ts', '@@ -1 +1 @@\n-old\n+new\n')],
    readBlob: async () => null,
    to: version('2', 'head-b', 'base-b'),
    toFiles: [patchFile('src/app.ts', '@@ -1 +1 @@\n-old\n+new and safer\n')],
  });
  expect(result.algorithm).toBe('region-aware-replay');
  expect(result.summary.empty).toBe(false);
  expect(result.files[0]).toMatchObject({ classes: ['incomplete'] });
});

test('preferring replay keeps an unmaterialized binary path incomplete', async () => {
  const result = await computeVersionComparePreferringReplay({
    from: version('1', 'head-a', 'base-a'),
    fromFiles: [],
    readBlob: async () => null,
    to: version('2', 'head-b', 'base-b'),
    // Binary / empty patch with no blobs and no reconstructable body.
    toFiles: [
      {
        newPath: 'src/binary.bin',
        oldPath: 'src/binary.bin',
        patchBody: '',
        status: 'modified',
      },
    ],
  });
  expect(result.algorithm).toBe('region-aware-replay');
  expect(result.files[0]).toMatchObject({ classes: ['incomplete'] });
  expect(result.warnings?.some((warning) => warning.includes('Fell back'))).toBe(false);
});

test('pure rebase with blobs yields empty versionCompare', async () => {
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');
  const patch = '@@ -1,2 +1,2 @@\n const value = 1;\n-old();\n+newCall();\n';
  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles: [patchFile('src/app.ts', patch)],
    readBlob: (path, ref) => {
      if (path !== 'src/app.ts') {
        return null;
      }
      if (ref === 'base-a') {
        return 'const value = 1;\nold();\n';
      }
      if (ref === 'head-a') {
        return 'const value = 1;\nnewCall();\n';
      }
      if (ref === 'base-b') {
        return 'const value = 1;\nold();\n';
      }
      if (ref === 'head-b') {
        return 'const value = 1;\nnewCall();\n';
      }
      return null;
    },
    to,
    toFiles: [patchFile('src/app.ts', patch)],
  });
  expect(result.algorithm).toBe('region-aware-replay');
  expect(result.summary.empty).toBe(true);
  expect(result.files).toEqual([]);
});

// === Regression tests (plan.md §4) ===

test('computeLineDiff: unchanged function in a changed file is excluded (Test A)', () => {
  // Two file versions where one hunk differs and an unchanged region
  // (apply_strategy) is identical. The localized diff must exclude
  // the unchanged region entirely.
  const left =
    [
      'fn setup() {',
      '    init();',
      '}',
      '',
      'fn apply_strategy() {',
      '    // complex logic',
      '    let x = compute();',
      '    validate(x);',
      '}',
      '',
      'fn teardown() {',
      '    cleanup();',
      '}',
    ].join('\n') + '\n';

  const right =
    [
      'fn setup() {',
      '    init();',
      '    extra_setup();',
      '}',
      '',
      'fn apply_strategy() {',
      '    // complex logic',
      '    let x = compute();',
      '    validate(x);',
      '}',
      '',
      'fn teardown() {',
      '    cleanup();',
      '}',
    ].join('\n') + '\n';

  const result = computeLineDiff(left, right);
  expect(result.incomplete).toBe(false);
  expect(result.patchBody).not.toBe('');
  // The diff should contain the added line.
  expect(result.patchBody).toContain('+    extra_setup();');
  // The unchanged function must NOT appear as a changed line.
  expect(result.patchBody).not.toContain('+fn apply_strategy');
  expect(result.patchBody).not.toContain('-fn apply_strategy');
  expect(result.patchBody).not.toContain('+    let x = compute');
  expect(result.patchBody).not.toContain('-    let x = compute');
  expect(result.patchBody).not.toContain('+    validate(x)');
  expect(result.patchBody).not.toContain('-    validate(x)');
});

test('large path count uses regional replay without approximate fallback (Test B)', async () => {
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');

  // Create 20 files — well above the old 12-path cutoff.
  const fromFiles: Array<ReturnType<typeof patchFile>> = [];
  const toFiles: Array<ReturnType<typeof patchFile>> = [];
  const blobs = new Map<string, string>();
  for (let i = 0; i < 20; i++) {
    const path = `src/file-${i}.ts`;
    fromFiles.push(patchFile(path, `@@ -1 +1 @@\n-old${i}\n+new${i}\n`));
    toFiles.push(patchFile(path, `@@ -1 +1 @@\n-old${i}\n+new${i} revised\n`));
    blobs.set(`base-a:${path}`, `old${i}\n`);
    blobs.set(`head-a:${path}`, `new${i}\n`);
    blobs.set(`base-b:${path}`, `old${i}\n`);
    blobs.set(`head-b:${path}`, `new${i} revised\n`);
  }

  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles,
    readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
    to,
    toFiles,
  });

  // Must use region-aware replay, never approximate patch text.
  expect(result.algorithm).toBe('region-aware-replay');
  // Should contain localized hunks (not whole-file replacements).
  expect(result.summary.filesChanged).toBe(20);
  // No warning about "patch-text version comparison because this range contains N files".
  expect(
    result.warnings?.some((w) => w.includes('patch-text version comparison because')),
  ).toBeFalsy();
});

test('likely-revised interdiff produces localized hunks (Test C)', async () => {
  // A likely-revised commit pair where one function changed and another did not.
  const from = version('old-sha', 'old-sha', 'old-parent');
  const to = version('new-sha', 'new-sha', 'new-parent');

  const unchangedFn = '\nfn untouched() {\n    stable_code();\n}\n';
  const fromPatch = `@@ -1,2 +1,2 @@\n fn main() {\n-    v1();\n+    v1_impl();\n`;
  const toPatch = `@@ -1,2 +1,2 @@\n fn main() {\n-    v1();\n+    v2_impl();\n`;

  const blobs = new Map<string, string>();
  blobs.set('old-parent:src/lib.rs', `fn main() {\n    v1();\n}${unchangedFn}`);
  blobs.set('old-sha:src/lib.rs', `fn main() {\n    v1_impl();\n}${unchangedFn}`);
  blobs.set('new-parent:src/lib.rs', `fn main() {\n    v1();\n}${unchangedFn}`);
  blobs.set('new-sha:src/lib.rs', `fn main() {\n    v2_impl();\n}${unchangedFn}`);

  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles: [patchFile('src/lib.rs', fromPatch)],
    readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
    to,
    toFiles: [patchFile('src/lib.rs', toPatch)],
  });

  expect(result.algorithm).toBe('region-aware-replay');
  expect(result.summary.filesChanged).toBe(1);
  const patch = result.files[0]?.file.sections[0]?.patch ?? '';
  // Should show the actual change.
  expect(patch).toContain('-    v1_impl();');
  expect(patch).toContain('+    v2_impl();');
  // The unchanged function must NOT appear as a change (+ or - prefix).
  // It may appear as context (space prefix) — that is acceptable per plan.md.
  expect(patch).not.toContain('-fn untouched');
  expect(patch).not.toContain('+fn untouched');
  expect(patch).not.toContain('-    stable_code');
  expect(patch).not.toContain('+    stable_code');
});

test('computeLineDiff handles identical files', () => {
  const result = computeLineDiff('hello\nworld\n', 'hello\nworld\n');
  expect(result.incomplete).toBe(false);
  expect(result.patchBody).toBe('');
});

test('computeLineDiff handles empty-to-content', () => {
  const result = computeLineDiff('', 'new line\n');
  expect(result.incomplete).toBe(false);
  expect(result.patchBody).toContain('+new line');
});

test('computeLineDiff handles content-to-empty', () => {
  const result = computeLineDiff('old line\n', '');
  expect(result.incomplete).toBe(false);
  expect(result.patchBody).toContain('-old line');
});

test('computeLineDiff produces multiple independent hunks', () => {
  // Two changes separated by many unchanged lines.
  const shared = Array.from({ length: 20 }, (_, i) => `line ${i + 2}`).join('\n');
  const left = `first\n${shared}\nlast\n`;
  const right = `FIRST\n${shared}\nLAST\n`;
  const result = computeLineDiff(left, right);
  expect(result.incomplete).toBe(false);
  // Should produce two separate hunks.
  const hunkHeaders = result.patchBody.match(/@@ /g);
  expect(hunkHeaders?.length).toBe(2);
});

test('conflict during replay stays a regional Later Base-to-Later HEAD comparison', async () => {
  // A replay conflict must not substitute Earlier HEAD -> Later HEAD. Its
  // primary patch remains the current edit on the later base, with the prior
  // patch retained in the regional projection.
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');

  // The from-patch expects "old line" at line 1, but the new base has "different base line".
  const fromPatch = '@@ -1,2 +1,2 @@\n old line\n-remove me\n+add me\n';
  const toPatch = '@@ -1,2 +1,2 @@\n different base line\n-other\n+result\n';

  const blobs = new Map<string, string>();
  blobs.set('base-a:src/app.rs', 'old line\nremove me\n');
  blobs.set('base-b:src/app.rs', 'different base line\nother\n');
  blobs.set('head-a:src/app.rs', 'old line\nadd me\n');
  blobs.set('head-b:src/app.rs', 'different base line\nresult\n');

  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles: [patchFile('src/app.rs', fromPatch)],
    readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
    to,
    toFiles: [patchFile('src/app.rs', toPatch)],
  });

  expect(result.algorithm).toBe('region-aware-replay');
  expect(result.summary.filesChanged).toBe(1);
  const patch = result.files[0]?.file.sections[0]?.patch ?? '';
  // Must never contain conflict markers.
  expect(patch).not.toContain('<<<<<<< source');
  expect(patch).not.toContain('>>>>>>> patch');
  // Must show B1 -> H1, not a direct H0 -> H1 fallback.
  expect(patch).toContain('-other');
  expect(patch).toContain('+result');
  expect(patch).not.toContain('-old line');
  expect(patch).not.toContain('+different base line');
  expect(result.files[0]?.projection?.regions).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'replay-conflict' })]),
  );
});

test('conflict during replay with missing evidence stays incomplete', async () => {
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');

  const fromPatch = '@@ -1,2 +1,2 @@\n old line\n-remove me\n+add me\n';
  const toPatch = '@@ -1,2 +1,2 @@\n different base line\n-other\n+result\n';

  const blobs = new Map<string, string>();
  blobs.set('base-b:src/app.rs', 'different base line\nother\n');
  blobs.set('head-b:src/app.rs', 'different base line\nresult\n');
  // Earlier endpoint blobs are unavailable.

  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles: [patchFile('src/app.rs', fromPatch)],
    readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
    to,
    toFiles: [patchFile('src/app.rs', toPatch)],
  });

  expect(result.algorithm).toBe('region-aware-replay');
  expect(result.files[0]).toMatchObject({ classes: ['incomplete'] });
  // An incomplete projection still never contains synthetic conflict markers.
  for (const file of result.files) {
    const patch = file.file.sections[0]?.patch ?? '';
    expect(patch).not.toContain('<<<<<<< source');
    expect(patch).not.toContain('>>>>>>> patch');
  }
});
