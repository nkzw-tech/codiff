import { describe, expect, test, vi } from 'vite-plus/test';
import {
  computeVersionComparePreferringReplay,
  type ReplayCompareEndpoint,
  type ReplayPatchFile,
} from '../lib/rebase-replay-compare.ts';
import type { GitSha, ReviewVersionId } from '../types.ts';

const gitSha = (value: string) => value as GitSha;
const reviewVersionId = (value: string) => value as ReviewVersionId;

const endpoint = (id: string, baseSha: string, headSha: string): ReplayCompareEndpoint => ({
  baseSha: gitSha(baseSha),
  createdAt: '2026-07-22T00:00:00.000Z',
  headSha: gitSha(headSha),
  label: id,
  versionId: reviewVersionId(id),
});

const patchFile = (patchBody: string): ReplayPatchFile => ({
  newPath: 'src/app.ts',
  oldPath: 'src/app.ts',
  patchBody,
  status: 'modified',
});

describe('rebase replay comparison', () => {
  test('stops before evidence acquisition when the comparison is superseded', async () => {
    const controller = new AbortController();
    const readBlobs = vi.fn(async () => new Map<string, string | null>());
    controller.abort();

    await expect(
      computeVersionComparePreferringReplay({
        from: endpoint('old', 'base-old', 'head-old'),
        fromFiles: [patchFile('@@ -1 +1 @@\n-old\n+prior\n')],
        readBlob: async () => null,
        readBlobs,
        signal: controller.signal,
        to: endpoint('new', 'base-new', 'head-new'),
        toFiles: [patchFile('@@ -1 +1 @@\n-base\n+current\n')],
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(readBlobs).not.toHaveBeenCalled();
  });

  test('stops after an in-flight evidence batch is superseded', async () => {
    const controller = new AbortController();
    const readBlobs = vi.fn(async () => {
      controller.abort();
      return new Map<string, string | null>();
    });

    await expect(
      computeVersionComparePreferringReplay({
        from: endpoint('old', 'base-old', 'head-old'),
        fromFiles: [patchFile('@@ -1 +1 @@\n-old\n+prior\n')],
        readBlob: async () => null,
        readBlobs,
        signal: controller.signal,
        to: endpoint('new', 'base-new', 'head-new'),
        toFiles: [patchFile('@@ -1 +1 @@\n-base\n+current\n')],
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(readBlobs).toHaveBeenCalledTimes(1);
  });

  test('hides a pure rebase onto an advanced base', async () => {
    const from = endpoint('old', 'base-old', 'head-old');
    const to = endpoint('new', 'base-new', 'head-new');
    const blobs = new Map<string, string>([
      ['base-old:src/app.ts', 'const base = "old";\nconst value = 1;\n'],
      ['head-old:src/app.ts', 'const base = "old";\nconst value = 2;\n'],
      ['base-new:src/app.ts', 'const base = "new";\nconst value = 1;\n'],
      ['head-new:src/app.ts', 'const base = "new";\nconst value = 2;\n'],
    ]);

    const result = await computeVersionComparePreferringReplay({
      from,
      fromFiles: [patchFile('@@ -2,1 +2,1 @@\n-const value = 1;\n+const value = 2;\n')],
      readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
      to,
      toFiles: [patchFile('@@ -2,1 +2,1 @@\n-const value = 1;\n+const value = 2;\n')],
    });

    expect(result.algorithm).toBe('region-aware-replay');
    expect(result.files).toEqual([]);
    expect(result.summary.empty).toBe(true);
  });

  test('uses complete added and deleted patches as exact endpoint evidence', async () => {
    const readBlob = vi.fn(async () => {
      throw new Error('Complete one-sided artifact evidence must not read a blob.');
    });
    const readBlobs = vi.fn(async () => {
      throw new Error('Complete one-sided artifact evidence must not request a blob batch.');
    });
    const addedFrom = {
      coverage: 'complete',
      newPath: 'src/added.ts',
      oldPath: 'src/added.ts',
      patchBody: '@@ -0,0 +1 @@\n+prior\n',
      status: 'added',
    } satisfies ReplayPatchFile;
    const addedTo = {
      coverage: 'complete',
      newPath: 'src/added.ts',
      oldPath: 'src/added.ts',
      patchBody: '@@ -0,0 +1 @@\n+current\n',
      status: 'added',
    } satisfies ReplayPatchFile;
    const added = await computeVersionComparePreferringReplay({
      from: endpoint('old', 'base-old', 'head-old'),
      fromFiles: [addedFrom],
      readBlob,
      readBlobs,
      to: endpoint('new', 'base-new', 'head-new'),
      toFiles: [addedTo],
    });

    expect(added.files[0]?.classes).not.toContain('incomplete');
    expect(added.files[0]?.file.sections[0]?.patch).toContain('-prior');
    expect(added.files[0]?.file.sections[0]?.patch).toContain('+current');

    const deletedFrom = {
      coverage: 'complete',
      newPath: 'src/deleted.ts',
      oldPath: 'src/deleted.ts',
      patchBody: '@@ -1 +0,0 @@\n-prior\n',
      status: 'deleted',
    } satisfies ReplayPatchFile;
    const deletedTo = {
      coverage: 'complete',
      newPath: 'src/deleted.ts',
      oldPath: 'src/deleted.ts',
      patchBody: '@@ -1 +0,0 @@\n-current\n',
      status: 'deleted',
    } satisfies ReplayPatchFile;
    const deleted = await computeVersionComparePreferringReplay({
      from: endpoint('old', 'base-old', 'head-old'),
      fromFiles: [deletedFrom],
      readBlob,
      readBlobs,
      to: endpoint('new', 'base-new', 'head-new'),
      toFiles: [deletedTo],
    });

    expect(deleted.files[0]?.classes).not.toContain('incomplete');
    expect(deleted.files[0]?.file.sections[0]?.patch).toContain('-current');
    expect(readBlob).not.toHaveBeenCalled();
    expect(readBlobs).not.toHaveBeenCalled();
  });

  test('uses equal complete modified final object IDs as exact empty evidence', async () => {
    const readBlob = vi.fn(async () => {
      throw new Error('Equal final object IDs must not read a blob.');
    });
    const readBlobs = vi.fn(async () => {
      throw new Error('Equal final object IDs must not request a blob batch.');
    });
    const finalObjectId = 'f'.repeat(40);
    const result = await computeVersionComparePreferringReplay({
      from: endpoint('old', 'base-old', 'head-old'),
      fromFiles: [
        {
          coverage: 'complete',
          newObjectId: finalObjectId,
          newPath: 'src/app.ts',
          oldObjectId: 'a'.repeat(40),
          oldPath: 'src/app.ts',
          patchBody: '@@ -1 +1 @@\n-base old\n+final\n',
          status: 'modified',
        },
      ],
      readBlob,
      readBlobs,
      to: endpoint('new', 'base-new', 'head-new'),
      toFiles: [
        {
          coverage: 'complete',
          newObjectId: finalObjectId,
          newPath: 'src/app.ts',
          oldObjectId: 'b'.repeat(40),
          oldPath: 'src/app.ts',
          patchBody: '@@ -1 +1 @@\n-base new\n+final\n',
          status: 'modified',
        },
      ],
    });

    expect(result.files).toEqual([]);
    expect(result.summary.empty).toBe(true);
    expect(readBlob).not.toHaveBeenCalled();
    expect(readBlobs).not.toHaveBeenCalled();
  });

  test('does not treat all-zero modified object IDs as content evidence', async () => {
    const from = endpoint('old', 'base-old', 'head-old');
    const to = endpoint('new', 'base-new', 'head-new');
    const contents = new Map<string, string>([
      ['base-old:src/app.ts', 'base\n'],
      ['head-old:src/app.ts', 'old\n'],
      ['base-new:src/app.ts', 'base\n'],
      ['head-new:src/app.ts', 'new\n'],
    ]);
    const readBlobs = vi.fn(
      async (requests: ReadonlyArray<{ path: string; ref: string }>) =>
        new Map(
          requests.map((request) => [
            `${request.ref}:${request.path}`,
            contents.get(`${request.ref}:${request.path}`) ?? null,
          ]),
        ),
    );
    const placeholderObjectId = '0'.repeat(40);
    const result = await computeVersionComparePreferringReplay({
      from,
      fromFiles: [
        {
          coverage: 'complete',
          newObjectId: placeholderObjectId,
          newPath: 'src/app.ts',
          oldPath: 'src/app.ts',
          patchBody: '@@ -1 +1 @@\n-base\n+old\n',
          status: 'modified',
        },
      ],
      readBlob: async () => {
        throw new Error('A batch-capable replay must not issue serial blob reads.');
      },
      readBlobs,
      to,
      toFiles: [
        {
          coverage: 'complete',
          newObjectId: placeholderObjectId,
          newPath: 'src/app.ts',
          oldPath: 'src/app.ts',
          patchBody: '@@ -1 +1 @@\n-base\n+new\n',
          status: 'modified',
        },
      ],
    });

    expect(result.files[0]?.file.sections[0]?.patch).toContain('-old');
    expect(result.files[0]?.file.sections[0]?.patch).toContain('+new');
    expect(readBlobs).toHaveBeenCalledTimes(1);
  });

  test('reports only the intentional edit after a rebase', async () => {
    const from = endpoint('old', 'base-old', 'head-old');
    const to = endpoint('new', 'base-new', 'head-new');
    const blobs = new Map<string, string>([
      ['base-old:src/app.ts', 'const base = "old";\nconst value = 1;\n'],
      ['head-old:src/app.ts', 'const base = "old";\nconst value = 2;\n'],
      ['base-new:src/app.ts', 'const base = "new";\nconst value = 1;\n'],
      ['head-new:src/app.ts', 'const base = "new";\nconst value = 3;\n'],
    ]);

    const result = await computeVersionComparePreferringReplay({
      from,
      fromFiles: [patchFile('@@ -2,1 +2,1 @@\n-const value = 1;\n+const value = 2;\n')],
      readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
      to,
      toFiles: [patchFile('@@ -2,1 +2,1 @@\n-const value = 1;\n+const value = 3;\n')],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.file.sections[0]?.patch).toContain('-const value = 2;');
    expect(result.files[0]?.file.sections[0]?.patch).toContain('+const value = 3;');
    expect(result.files[0]?.file.sections[0]?.patch).not.toContain('-const base =');
    expect(result.files[0]?.file.sections[0]?.patch).not.toContain('+const base =');
  });

  test('keeps a replay conflict as a regional B1-to-H1 projection', async () => {
    const from = endpoint('old', 'base-old', 'head-old');
    const to = endpoint('new', 'base-new', 'head-new');
    const blobs = new Map<string, string>([
      ['base-old:src/app.ts', 'old line\nremove me\n'],
      ['head-old:src/app.ts', 'old line\nadd me\n'],
      ['base-new:src/app.ts', 'different base line\nother\n'],
      ['head-new:src/app.ts', 'different base line\nresult\n'],
    ]);

    const result = await computeVersionComparePreferringReplay({
      from,
      fromFiles: [patchFile('@@ -1,2 +1,2 @@\n old line\n-remove me\n+add me\n')],
      readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
      to,
      toFiles: [patchFile('@@ -1,2 +1,2 @@\n different base line\n-other\n+result\n')],
    });

    expect(result.algorithm).toBe('region-aware-replay');
    expect(result.files[0]?.projection?.regions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'replay-conflict' })]),
    );
    const patch = result.files[0]?.file.sections[0]?.patch ?? '';
    expect(patch).toContain('-other');
    expect(patch).toContain('+result');
    expect(patch).not.toContain('-old line');
    expect(patch).not.toContain('+different base line');
  });

  test('keeps a later rename in one regional projection with both endpoint paths', async () => {
    const from = endpoint('old', 'base-old', 'head-old');
    const to = endpoint('new', 'base-new', 'head-new');
    const fromFile = {
      newPath: 'src/old.ts',
      oldPath: 'src/old.ts',
      patchBody: '@@ -1 +1 @@\n-old\n+prior\n',
      status: 'modified' as const,
    } satisfies ReplayPatchFile;
    const toFile = {
      newPath: 'src/new.ts',
      oldPath: 'src/old.ts',
      patchBody: '@@ -1 +1 @@\n-base\n+current\n',
      status: 'renamed' as const,
    } satisfies ReplayPatchFile;
    const blobs = new Map<string, string>([
      ['base-old:src/old.ts', 'old\n'],
      ['head-old:src/old.ts', 'prior\n'],
      ['base-new:src/old.ts', 'base\n'],
      ['head-new:src/new.ts', 'current\n'],
    ]);

    const result = await computeVersionComparePreferringReplay({
      comments: [
        {
          commentId: 'old-path-comment',
          filePath: 'src/old.ts',
          position: { baseSha: from.baseSha, headSha: from.headSha },
        },
      ],
      from,
      fromFiles: [fromFile],
      readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
      to,
      toFiles: [toFile],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      oldPath: 'src/old.ts',
      path: 'src/new.ts',
      relatedCommentIds: ['old-path-comment'],
      status: 'renamed',
    });
    expect(result.files[0]?.projection?.endpointPaths).toMatchObject({
      earlierBase: 'src/old.ts',
      earlierHead: 'src/old.ts',
      laterBase: 'src/old.ts',
      laterHead: 'src/new.ts',
    });
    expect(result.files[0]?.file.sections[0]?.patch).toContain('-base');
    expect(result.files[0]?.file.sections[0]?.patch).toContain('+current');
    expect(result.commentAssociations).toEqual([
      { commentId: 'old-path-comment', filePath: 'src/old.ts', status: 'outdated' },
    ]);
  });

  test('keeps an unchanged B1/H1 context hunk for a zero-current-edit conflict', async () => {
    const from = endpoint('old', 'base-old', 'head-old');
    const to = endpoint('new', 'base-new', 'head-new');
    const blobs = new Map<string, string>([
      ['base-old:src/app.ts', 'before\nsubject old\nafter\n'],
      ['head-old:src/app.ts', 'before\nsubject prior\nafter\n'],
      ['base-new:src/app.ts', 'before\nsubject base\nafter\n'],
      ['head-new:src/app.ts', 'before\nsubject base\nafter\n'],
    ]);

    const result = await computeVersionComparePreferringReplay({
      from,
      fromFiles: [patchFile('@@ -1,3 +1,3 @@\n before\n-subject old\n+subject prior\n after\n')],
      readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
      to,
      toFiles: [patchFile('')],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.projection?.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ affectedCurrentEditIds: [], kind: 'replay-conflict' }),
      ]),
    );
    const patch = result.files[0]?.file.sections[0]?.patch ?? '';
    expect(patch).toContain('@@ -1,3 +1,3 @@');
    expect(patch).toContain(' before');
    expect(patch).toContain(' subject base');
    expect(patch).toContain(' after');
    expect(patch).not.toContain('+subject base');
    expect(patch).not.toContain('-subject base');
  });

  test('retains unchanged clean projection regions as ordered context hunks', async () => {
    const from = endpoint('old', 'base-old', 'head-old');
    const to = endpoint('new', 'base-new', 'head-new');
    const blobs = new Map<string, string>([
      ['base-old:src/app.ts', 'start\nold\nboundary\nclean one\nclean two\n'],
      ['head-old:src/app.ts', 'start\nprior\nboundary\nclean one\nclean two\n'],
      ['base-new:src/app.ts', 'start\nbase\nboundary\nclean one\nclean two\n'],
      ['head-new:src/app.ts', 'start\ncurrent\nboundary\nclean one\nclean two\n'],
    ]);

    const result = await computeVersionComparePreferringReplay({
      from,
      fromFiles: [
        patchFile('@@ -1,5 +1,5 @@\n start\n-old\n+prior\n boundary\n clean one\n clean two\n'),
      ],
      readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
      to,
      toFiles: [
        patchFile('@@ -1,5 +1,5 @@\n start\n-base\n+current\n boundary\n clean one\n clean two\n'),
      ],
    });

    const patch = result.files[0]?.file.sections[0]?.patch ?? '';
    expect(result.files[0]?.projection?.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'replay-clean' }),
        expect.objectContaining({ kind: 'replay-conflict' }),
      ]),
    );
    expect(patch).toContain('-base');
    expect(patch).toContain('+current');
    expect(patch).toContain(' clean one');
    expect(patch).toContain(' clean two');
    expect(patch.match(/^@@ /gm)).toHaveLength(2);
  });

  test('reports missing endpoint evidence as incomplete instead of falling back', async () => {
    const result = await computeVersionComparePreferringReplay({
      from: endpoint('old', 'base-old', 'head-old'),
      fromFiles: [patchFile('@@ -1 +1 @@\n-old\n+new\n')],
      readBlob: async () => null,
      to: endpoint('new', 'base-new', 'head-new'),
      toFiles: [patchFile('@@ -1 +1 @@\n-old\n+newer\n')],
    });

    expect(result.algorithm).toBe('region-aware-replay');
    expect(result.files[0]).toMatchObject({ classes: ['incomplete'] });
    expect(result.files[0]?.projection?.regions).toMatchObject([{ completeness: 'incomplete' }]);
    expect(result.files[0]?.file.sections[0]?.patch).toContain('@@ -0,0 +0,0 @@');
    expect(result.warnings?.join('\n')).not.toContain('Fell back');
    expect(result.warnings?.join('\n')).not.toContain('Approximate');
  });

  test('uses one proof-triggered endpoint batch without serial blob fallbacks', async () => {
    const from = endpoint('old', 'base-old', 'head-old');
    const to = endpoint('new', 'base-new', 'head-new');
    const contents = new Map<string, string>([
      ['base-old:src/app.ts', 'const base = "old";\nconst value = 1;\n'],
      ['head-old:src/app.ts', 'const base = "old";\nconst value = 2;\n'],
      ['base-new:src/app.ts', 'const base = "new";\nconst value = 1;\n'],
      ['head-new:src/app.ts', 'const base = "new";\nconst value = 2;\n'],
    ]);
    const readBlob = vi.fn(async () => {
      throw new Error('A batch-capable replay must not issue serial blob reads.');
    });
    const readBlobs = vi.fn(
      async (requests: ReadonlyArray<{ path: string; ref: string }>) =>
        new Map(
          requests.map((request) => [
            `${request.ref}:${request.path}`,
            contents.get(`${request.ref}:${request.path}`) ?? null,
          ]),
        ),
    );

    const result = await computeVersionComparePreferringReplay({
      from,
      fromFiles: [patchFile('@@ -2,1 +2,1 @@\n-const value = 1;\n+const value = 2;\n')],
      readBlob,
      readBlobs,
      to,
      toFiles: [patchFile('@@ -2,1 +2,1 @@\n-const value = 1;\n+const value = 2;\n')],
    });

    expect(result.summary.empty).toBe(true);
    expect(readBlobs).toHaveBeenCalledTimes(1);
    expect(readBlobs.mock.calls[0]?.[0]).toEqual([
      { path: 'src/app.ts', ref: 'base-old' },
      { path: 'src/app.ts', ref: 'head-old' },
      { path: 'src/app.ts', ref: 'base-new' },
      { path: 'src/app.ts', ref: 'head-new' },
    ]);
    expect(readBlob).not.toHaveBeenCalled();
  });

  test('reports replay evidence and projection diagnostics without affecting the result', async () => {
    const diagnostics = vi.fn();
    const readBlob = vi.fn(async () => {
      throw new Error('A batch-capable replay must not issue serial blob reads.');
    });
    const result = await computeVersionComparePreferringReplay({
      from: endpoint('old', 'base-old', 'head-old'),
      fromFiles: [patchFile('@@ -1 +1 @@\n-old\n+prior\n')],
      now: (() => {
        let value = 0;
        return () => {
          value += 5;
          return value;
        };
      })(),
      onDiagnostics: diagnostics,
      readBlob,
      readBlobs: async () => new Map(),
      to: endpoint('new', 'base-new', 'head-new'),
      toFiles: [patchFile('@@ -1 +1 @@\n-base\n+current\n')],
    });

    expect(result.files).toHaveLength(1);
    expect(readBlob).not.toHaveBeenCalled();
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(diagnostics.mock.calls[0]?.[0]).toMatchObject({
      artifactOnlyPairCount: 0,
      evidence: { requested: 4, resolved: 0, unavailable: 4 },
      projection: { attemptedPairs: 1, incompleteRegions: 1, renderedFiles: 1 },
    });
    expect(diagnostics.mock.calls[0]?.[0]?.elapsedMs).toBeGreaterThan(0);
    expect(diagnostics.mock.calls[0]?.[0]?.evidence.elapsedMs).toBeGreaterThan(0);
    expect(diagnostics.mock.calls[0]?.[0]?.projection.elapsedMs).toBeGreaterThan(0);
  });

  test('deduplicates compatibility endpoint reads before rendering regional projections', async () => {
    const from = endpoint('old', 'shared-base', 'shared-head');
    const to = endpoint('new', 'shared-base', 'shared-head');
    const contents = new Map<string, string>([
      ['shared-base:src/app.ts', 'const value = 1;\n'],
      ['shared-head:src/app.ts', 'const value = 2;\n'],
    ]);
    const readBlob = vi.fn(
      async (path: string, ref: string) => contents.get(`${ref}:${path}`) ?? null,
    );

    const result = await computeVersionComparePreferringReplay({
      from,
      fromFiles: [patchFile('@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n')],
      readBlob,
      to,
      toFiles: [patchFile('@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n')],
    });

    expect(result.summary.empty).toBe(true);
    expect(readBlob).toHaveBeenCalledTimes(2);
    expect(readBlob.mock.calls).toEqual([
      ['src/app.ts', 'shared-base'],
      ['src/app.ts', 'shared-head'],
    ]);
  });
});
