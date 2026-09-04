import { expect, test, vi } from 'vite-plus/test';
import {
  createReviewContentRun,
  decodeImageRevision,
  decodeTextRevision,
} from '../lib/review-content.ts';
import type {
  ChangedFile,
  GitSha,
  ResolvedRevisionBytes,
  RevisionContentBatchRequest,
} from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';

const gitSha = (character: string) => character.repeat(40) as GitSha;

const createTransport = () =>
  vi.fn(async (request: RevisionContentBatchRequest) => ({
    results: request.requests.map((item) => {
      const coordinate =
        item.revision.kind === 'working-copy'
          ? 'working-copy'
          : item.revision.kind === 'index'
            ? `index:${item.revision.stage ?? 0}`
            : `commit:${item.revision.sha[0]}`;
      const bytes = new TextEncoder().encode(`${coordinate}:${item.path}`);
      return {
        key: item.key,
        status: 'ready' as const,
        value: {
          bytes,
          cacheKey: item.key,
          path: item.path,
          provenance: 'native-git' as const,
          size: bytes.byteLength,
        },
      };
    }),
  }));

test('resolves commit, index, and working-copy ranges without source-kind dispatch', async () => {
  const transport = createTransport();
  const run = createReviewContentRun({
    generation: 'generation-1',
    source: { type: 'working-tree' },
    transport,
  });
  const staged = createChangedFile('src/staged.ts', { kind: 'staged' });
  const unstaged = createChangedFile('src/unstaged.ts');

  const [stagedFiles, unstagedFiles] = await run.resolveSectionContentsBatch([
    { file: staged, section: staged.sections[0]! },
    { file: unstaged, section: unstaged.sections[0]! },
  ]);

  expect(stagedFiles.oldFile?.contents).toBe('commit:a:src/staged.ts');
  expect(stagedFiles.newFile.contents).toBe('index:0:src/staged.ts');
  expect(unstagedFiles.oldFile?.contents).toBe('index:0:src/unstaged.ts');
  expect(unstagedFiles.newFile.contents).toBe('working-copy:src/unstaged.ts');
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]![0].requests).toHaveLength(4);
});

test('keeps renamed, added, and deleted sides aligned with their revision coordinates', async () => {
  const transport = createTransport();
  const run = createReviewContentRun({
    generation: 'generation-1',
    source: { sha: gitSha('b'), type: 'commit' },
    transport,
  });
  const renamed: ChangedFile = {
    ...createChangedFile('src/new.ts', { kind: 'commit', status: 'renamed' }),
    oldPath: 'src/old.ts',
  };
  const added = createChangedFile('src/added.ts', { kind: 'commit', status: 'added' });
  const deleted = createChangedFile('src/deleted.ts', { kind: 'commit', status: 'deleted' });

  const [renamedFiles, addedFiles, deletedFiles] = await run.resolveSectionContentsBatch([
    { file: renamed, section: renamed.sections[0]! },
    { file: added, section: added.sections[0]! },
    { file: deleted, section: deleted.sections[0]! },
  ]);

  expect(renamedFiles.oldFile?.contents).toBe('commit:a:src/old.ts');
  expect(renamedFiles.newFile.contents).toBe('commit:b:src/new.ts');
  expect(addedFiles.oldFile).toBeNull();
  expect(addedFiles.newFile.contents).toBe('commit:b:src/added.ts');
  expect(deletedFiles.oldFile?.contents).toBe('commit:a:src/deleted.ts');
  expect(deletedFiles.newFile.contents).toBe('');
  expect(transport.mock.calls[0]![0].requests).toHaveLength(4);
});

test('joins concurrent consumers and caches immutable and mutable reads inside one run', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const baseTransport = createTransport();
  const transport = vi.fn(async (request: RevisionContentBatchRequest) => {
    await gate;
    return baseTransport(request);
  });
  const run = createReviewContentRun({
    generation: 'fingerprint-1',
    source: { type: 'working-tree' },
    transport,
  });
  const file = createChangedFile('src/shared.ts');
  const first = run.resolveSectionContents(file, file.sections[0]!);
  const second = run.resolveSectionContents(file, file.sections[0]!);
  release();

  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  await run.resolveSectionContents(file, file.sections[0]!);
  expect(transport).toHaveBeenCalledOnce();
  expect(run.diagnostics()).toMatchObject({ cacheHits: 4, sourceCalls: 1 });

  const nextRun = createReviewContentRun({
    generation: 'fingerprint-2',
    source: { type: 'working-tree' },
    transport,
  });
  await nextRun.resolveSectionContents(file, file.sections[0]!);
  expect(transport).toHaveBeenCalledTimes(2);
});

test('preserves index conflict stages and supports an absent unborn base', async () => {
  const transport = createTransport();
  const run = createReviewContentRun({
    generation: 'conflict',
    source: { type: 'working-tree' },
    transport,
  });
  const conflict = createChangedFile('src/conflict.ts');
  const conflictSection = {
    ...conflict.sections[0]!,
    range: {
      base: {
        kind: 'index' as const,
        label: { kind: 'review-marker' as const, text: 'Ours' },
        stage: 2 as const,
      },
      head: {
        kind: 'working-copy' as const,
        label: { kind: 'review-marker' as const, text: 'Working copy' },
      },
    },
  };
  const unborn = createChangedFile('src/first.ts', { kind: 'staged', status: 'added' });
  const unbornSection = {
    ...unborn.sections[0]!,
    range: {
      base: null,
      head: { kind: 'index' as const, label: { kind: 'review-marker' as const, text: 'Index' } },
    },
  };

  await run.resolveSectionContentsBatch([
    { file: conflict, section: conflictSection },
    { file: unborn, section: unbornSection },
  ]);

  const requests = transport.mock.calls[0]![0].requests;
  expect(requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ revision: expect.objectContaining({ kind: 'index', stage: 2 }) }),
    ]),
  );
  expect(requests.filter((request) => request.path === unborn.path)).toHaveLength(1);
});

test('decodes text and image policies from the same byte result', () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const value: ResolvedRevisionBytes = {
    bytes,
    cacheKey: 'png',
    path: 'image.png',
    provenance: 'native-git',
    size: bytes.byteLength,
  };

  expect(decodeImageRevision(value, 'image.png')).toMatchObject({
    dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    mimeType: 'image/png',
  });
  expect(() => decodeImageRevision(value, 'image.svg')).toThrow('Unsupported image file type');
  expect(() =>
    decodeTextRevision({ ...value, bytes: Uint8Array.from([0]) }, 'file.bin', 'empty'),
  ).toThrow('the file is binary');
  expect(decodeTextRevision(null, 'empty.ts', 'empty-key')).toEqual({
    cacheKey: 'empty-key',
    contents: '',
    name: 'empty.ts',
  });
});

test('aborts late content results when a run is replaced', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = vi.fn(async (request: RevisionContentBatchRequest) => {
    await gate;
    return createTransport()(request);
  });
  const run = createReviewContentRun({
    generation: 'old',
    source: { sha: gitSha('b'), type: 'commit' },
    transport,
  });
  const file = createChangedFile('src/late.ts', { kind: 'commit' });
  const read = run.resolveSectionContents(file, file.sections[0]!);
  const error = new Error('Replaced');
  error.name = 'AbortError';
  run.abort(error);
  release();

  await expect(read).rejects.toMatchObject({ name: 'AbortError' });
});
