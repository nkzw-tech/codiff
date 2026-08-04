import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import { createCommitFingerprint } from '../../core/lib/commit-stack-evolution.ts';
import type { CommitArtifact, ReviewArtifactProvenance } from '../../core/lib/review-artifacts.ts';
import type { GitSha } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const {
  createNativeCommitArtifactSource,
  parseCommitArtifactOutput,
  readBlobArtifacts,
  readCommitArtifacts,
} = require('../git-state/commit-artifacts.cjs') as {
  createNativeCommitArtifactSource: (
    repoRoot: string,
    project: ReviewArtifactProvenance['project'],
    options?: {
      maxRangeArtifactBytes?: number;
      runGit?: typeof runGit;
      runGitWithInput?: typeof gitBufferWithInput;
    },
  ) => import('../../core/lib/review-artifacts.ts').ReviewArtifactSource;
  parseCommitArtifactOutput: (
    output: string,
    provenance: ReviewArtifactProvenance,
  ) => ReadonlyMap<GitSha, CommitArtifact>;
  readCommitArtifacts: (
    repoRoot: string,
    commits: ReadonlyArray<GitSha>,
    options?: {
      maxBytes?: number;
      provenance?: ReviewArtifactProvenance;
      runGit?: (
        repoRoot: string,
        args: ReadonlyArray<string>,
        input: string,
        options?: { signal?: AbortSignal },
      ) => Promise<Buffer>;
      signal?: AbortSignal;
    },
  ) => Promise<ReadonlyMap<GitSha, CommitArtifact>>;
  readBlobArtifacts: (
    repoRoot: string,
    objectIds: ReadonlyArray<string>,
    options: {
      maxBytes?: number;
      provenance: ReviewArtifactProvenance;
      runGit?: (
        repoRoot: string,
        args: ReadonlyArray<string>,
        input: string,
        options?: { signal?: AbortSignal },
      ) => Promise<Buffer>;
      runGitStream?: (
        repoRoot: string,
        args: ReadonlyArray<string>,
        input: string,
        options?: { onStdout?: (chunk: Buffer) => void; signal?: AbortSignal },
      ) => Promise<void>;
      signal?: AbortSignal;
    },
  ) => Promise<ReadonlyMap<string, { bytes: Uint8Array; objectId: string }>>;
};
const { git: runGit, gitBufferWithInput } = require('../git-state/common.cjs') as {
  git: (
    repoRoot: string,
    args: ReadonlyArray<string>,
    options?: { signal?: AbortSignal },
  ) => Promise<string>;
  gitBufferWithInput: (
    repoRoot: string,
    args: ReadonlyArray<string>,
    input: string,
    options?: { signal?: AbortSignal },
  ) => Promise<Buffer>;
};
const git = (directory: string, args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
const provenance = {
  kind: 'native-git',
  project: { host: 'gitlab.example', project: 'group/project', provider: 'gitlab' },
} as const;

test('parses root and merge parents while preserving forge provenance', () => {
  const root = '1'.repeat(40) as GitSha;
  const merge = '2'.repeat(40) as GitSha;
  const firstParent = '3'.repeat(40) as GitSha;
  const secondParent = '4'.repeat(40) as GitSha;
  const artifacts = parseCommitArtifactOutput(
    [`commit ${root} `, `commit ${merge} ${firstParent} ${secondParent}`].join('\n'),
    provenance,
  );

  expect(artifacts.get(root)).toMatchObject({ parentSha: null, provenance });
  expect(artifacts.get(merge)).toMatchObject({ parentSha: firstParent, provenance });
});

test('reads deduplicated binary Blob Artifacts through one batch process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-blob-artifacts-'));
  execFileSync('git', ['init', '--quiet', directory]);
  const contents = Buffer.from([0, 1, 255, 10]);
  const path = join(directory, 'image.bin');
  await writeFile(path, contents);
  const objectId = git(directory, ['hash-object', '-w', path]);
  const runner = vi.fn(gitBufferWithInput);

  const blobs = await readBlobArtifacts(directory, [objectId, objectId], {
    provenance,
    runGit: runner,
  });

  expect(runner).toHaveBeenCalledTimes(1);
  expect([...blobs.get(objectId)!.bytes]).toEqual([...contents]);
});

test('drains an oversized native Blob Artifact batch while preserving completed early blobs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-bounded-blob-artifacts-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    const smallContents = Buffer.from('small proof blob\n');
    const largeContents = Buffer.alloc(2 * 1024 * 1024, 0x78);
    const smallPath = join(directory, 'small.bin');
    const largePath = join(directory, 'large.bin');
    await Promise.all([writeFile(smallPath, smallContents), writeFile(largePath, largeContents)]);
    const smallObjectId = git(directory, ['hash-object', '-w', smallPath]);
    const largeObjectId = git(directory, ['hash-object', '-w', largePath]);
    const maxBytes =
      Buffer.byteLength(`${smallObjectId} blob ${smallContents.length}\n`) +
      smallContents.length +
      1;

    const blobs = await readBlobArtifacts(directory, [smallObjectId, largeObjectId], {
      maxBytes,
      provenance,
    });

    expect([...blobs.get(smallObjectId)!.bytes]).toEqual([...smallContents]);
    expect(blobs.has(largeObjectId)).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test('parses Blob Artifact records across streaming chunk boundaries', async () => {
  const objectId = 'a'.repeat(40);
  const contents = Buffer.from([0, 10, 255, 65]);
  const header = Buffer.from(`${objectId} blob ${contents.length}\n`);
  const record = Buffer.concat([header, contents, Buffer.from('\n')]);
  const runGitStream = vi.fn(
    async (
      _repoRoot: string,
      _args: ReadonlyArray<string>,
      _input: string,
      options?: { onStdout?: (chunk: Buffer) => void },
    ) => {
      for (const chunk of [
        record.subarray(0, 9),
        record.subarray(9, header.length + 1),
        record.subarray(header.length + 1, record.length - 1),
        record.subarray(record.length - 1),
      ]) {
        options?.onStdout?.(chunk);
      }
    },
  );

  const blobs = await readBlobArtifacts('/repo', [objectId], {
    maxBytes: record.length,
    provenance,
    runGitStream,
  });

  expect(runGitStream).toHaveBeenCalledTimes(1);
  expect([...blobs.get(objectId)!.bytes]).toEqual([...contents]);
});

test('reads text, large, binary, rename, and mode Commit Artifacts in one Git process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-commit-artifacts-'));
  execFileSync('git', ['init', '--quiet', directory]);
  git(directory, ['config', 'user.email', 'codiff@example.com']);
  git(directory, ['config', 'user.name', 'Codiff']);
  await Promise.all([
    writeFile(join(directory, 'delete.txt'), 'remove me\n', 'utf8'),
    writeFile(join(directory, 'modify.txt'), 'before\n', 'utf8'),
    writeFile(join(directory, 'rename.txt'), 'rename me\n', 'utf8'),
    writeFile(join(directory, 'binary.dat'), Buffer.from([0, 1, 2, 3])),
    writeFile(join(directory, 'script.sh'), '#!/bin/sh\necho before\n', 'utf8'),
  ]);
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Create artifact fixtures']);
  const parent = git(directory, ['rev-parse', 'HEAD']) as GitSha;

  await Promise.all([
    writeFile(join(directory, 'add.txt'), 'added\n', 'utf8'),
    writeFile(join(directory, 'modify.txt'), 'after\n', 'utf8'),
    writeFile(join(directory, 'large.txt'), `${'x'.repeat(1024 * 1024 + 32)}\n`, 'utf8'),
    writeFile(join(directory, 'binary.dat'), Buffer.from([0, 1, 9, 3])),
    rename(join(directory, 'rename.txt'), join(directory, 'renamed.txt')),
    unlink(join(directory, 'delete.txt')),
    chmod(join(directory, 'script.sh'), 0o755),
  ]);
  git(directory, ['add', '-A']);
  git(directory, ['commit', '--quiet', '-m', 'Exercise complete artifacts']);
  const head = git(directory, ['rev-parse', 'HEAD']) as GitSha;
  const runner = vi.fn(gitBufferWithInput);

  const artifact = (await readCommitArtifacts(directory, [head], { runGit: runner })).get(head)!;
  const fingerprint = await createCommitFingerprint(
    { sha: head, title: 'Exercise complete artifacts' },
    artifact,
  );

  expect(runner).toHaveBeenCalledTimes(1);
  expect(artifact).toMatchObject({ commitSha: head, coverage: 'complete', parentSha: parent });
  expect(artifact.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'binary.dat' }),
      expect.objectContaining({ newMode: '100755', oldMode: '100644', path: 'script.sh' }),
      expect.objectContaining({ oldPath: 'rename.txt', path: 'renamed.txt', status: 'renamed' }),
    ]),
  );
  expect(artifact.files.find((file) => file.path === 'large.txt')?.patch?.length).toBeGreaterThan(
    1024 * 1024,
  );
  expect(fingerprint.exactChangeId).toBeTruthy();
  expect(fingerprint.changedPaths).toEqual(
    expect.arrayContaining(['add.txt', 'binary.dat', 'delete.txt', 'modify.txt']),
  );

  const stackRunner = vi.fn(runGit);
  const rangeRunner = vi.fn(gitBufferWithInput);
  const source = createNativeCommitArtifactSource(directory, provenance.project, {
    runGit: stackRunner,
    runGitWithInput: rangeRunner,
  });
  const { range, stack } = await source.readStackAndRange(
    parent,
    head,
    new AbortController().signal,
  );
  expect(stack.commits.map((commit) => commit.sha)).toEqual([head]);
  expect(range).toMatchObject({ baseSha: parent, coverage: 'complete', headSha: head });
  expect(range.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'add.txt', status: 'added' }),
      expect.objectContaining({ path: 'binary.dat', status: 'modified' }),
      expect.objectContaining({ oldPath: 'rename.txt', path: 'renamed.txt', status: 'renamed' }),
    ]),
  );
  expect(stackRunner).toHaveBeenCalledTimes(1);
  expect(rangeRunner).toHaveBeenCalledTimes(1);
}, 30_000);

test('drains oversized native diff-tree output and marks only the incomplete tail truncated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-bounded-commit-artifacts-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    git(directory, ['config', 'user.email', 'codiff@example.com']);
    git(directory, ['config', 'user.name', 'Codiff']);
    await writeFile(join(directory, 'app.ts'), 'base\n', 'utf8');
    git(directory, ['add', 'app.ts']);
    git(directory, ['commit', '--quiet', '-m', 'Create base']);

    await writeFile(join(directory, 'app.ts'), 'base\nsmall\n', 'utf8');
    git(directory, ['add', 'app.ts']);
    git(directory, ['commit', '--quiet', '-m', 'Add small change']);
    const completeSha = git(directory, ['rev-parse', 'HEAD']) as GitSha;

    await writeFile(join(directory, 'large.ts'), `${'x'.repeat(256 * 1024)}\n`, 'utf8');
    git(directory, ['add', 'large.ts']);
    git(directory, ['commit', '--quiet', '-m', 'Add oversized change']);
    const truncatedSha = git(directory, ['rev-parse', 'HEAD']) as GitSha;

    const artifacts = await readCommitArtifacts(directory, [completeSha, truncatedSha], {
      maxBytes: 4 * 1024,
      provenance,
    });

    expect(artifacts.get(completeSha)).toMatchObject({ coverage: 'complete' });
    expect(artifacts.get(completeSha)?.files[0]).toMatchObject({ coverage: 'complete' });
    expect(artifacts.get(truncatedSha)).toMatchObject({ coverage: 'truncated' });
    expect(artifacts.get(truncatedSha)?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ coverage: 'truncated', path: 'large.ts' }),
      ]),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test('drains an oversized native range diff while preserving completed early files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-bounded-range-artifacts-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    git(directory, ['config', 'user.email', 'codiff@example.com']);
    git(directory, ['config', 'user.name', 'Codiff']);
    await Promise.all([
      writeFile(join(directory, 'a-small.ts'), 'before\n', 'utf8'),
      writeFile(join(directory, 'z-large.ts'), 'before\n', 'utf8'),
    ]);
    git(directory, ['add', '.']);
    git(directory, ['commit', '--quiet', '-m', 'Create range fixture']);
    const baseSha = git(directory, ['rev-parse', 'HEAD']) as GitSha;

    await Promise.all([
      writeFile(join(directory, 'a-small.ts'), 'after\n', 'utf8'),
      writeFile(join(directory, 'z-large.ts'), `${'x'.repeat(256 * 1024)}\n`, 'utf8'),
    ]);
    git(directory, ['add', '.']);
    git(directory, ['commit', '--quiet', '-m', 'Create oversized range']);
    const headSha = git(directory, ['rev-parse', 'HEAD']) as GitSha;

    const source = createNativeCommitArtifactSource(directory, provenance.project, {
      maxRangeArtifactBytes: 32 * 1024,
    });
    const { range, stack } = await source.readStackAndRange(
      baseSha,
      headSha,
      new AbortController().signal,
    );

    expect(stack.commits.map((commit) => commit.sha)).toEqual([headSha]);
    expect(range.coverage).toBe('truncated');
    expect(range.files.find((file) => file.path === 'a-small.ts')).toMatchObject({
      coverage: 'complete',
      patch: expect.stringContaining('+after'),
    });
    expect(range.files.find((file) => file.path === 'z-large.ts')).toMatchObject({
      coverage: 'truncated',
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test('cancels an active Git child process', async () => {
  const controller = new AbortController();
  const pending = runGit(process.cwd(), ['cat-file', '--batch'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
