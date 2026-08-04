import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type {
  GitSha,
  Revision,
  RevisionContentBatchRequest,
  RevisionContentBatchResult,
} from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { readRevisionContent } = require('../review-content.cjs') as {
  readRevisionContent(
    launchPath: string,
    batch: RevisionContentBatchRequest,
  ): Promise<RevisionContentBatchResult>;
};
const { readGitHubFileBlobArtifacts, readGitLabFileBlobArtifacts } =
  require('../git-state/provider-artifact-sources.cjs') as {
    readGitHubFileBlobArtifacts(
      repoRoot: string,
      pull: { headSha?: string; host?: string; number?: number; owner: string; repo: string },
      requests: ReadonlyArray<{ maxBytes: number; path: string; ref: string }>,
      transport?: unknown,
    ): Promise<Map<string, { bytes: Uint8Array; provenance: { kind: string } }>>;
    readGitLabFileBlobArtifacts(
      repoRoot: string,
      mergeRequest: { headSha?: string; host: string; number?: number; projectPath: string },
      requests: ReadonlyArray<{ maxBytes: number; path: string; ref: string }>,
      transport?: unknown,
    ): Promise<Map<string, { bytes: Uint8Array; provenance: { kind: string } }>>;
  };

const git = (repo: string, ...args: Array<string>) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const gitSha = (value: string) => value as GitSha;
const commitRevision = (sha: string): Revision => ({
  label: { kind: 'commit', text: sha.slice(0, 7) },
  sha: gitSha(sha),
});

const createRepository = async () => {
  const directory = await createTemporaryDirectory('codiff-review-content-');
  git(directory.path, 'init', '--quiet');
  git(directory.path, 'config', 'user.email', 'codiff@example.com');
  git(directory.path, 'config', 'user.name', 'Codiff Test');
  await mkdir(join(directory.path, 'src'), { recursive: true });
  return directory;
};

test('reads commit, index, and working-copy bytes in one revision batch', async () => {
  await using directory = await createRepository();
  const path = 'src/file.txt';
  await writeFile(join(directory.path, path), 'committed\n');
  git(directory.path, 'add', path);
  git(directory.path, 'commit', '--quiet', '-m', 'Add file');
  const sha = git(directory.path, 'rev-parse', 'HEAD');
  await writeFile(join(directory.path, path), 'indexed\n');
  git(directory.path, 'add', path);
  await writeFile(join(directory.path, path), 'working\n');
  const requests = [
    { key: 'commit', maxBytes: 1024, path, revision: commitRevision(sha) },
    {
      key: 'index',
      maxBytes: 1024,
      path,
      revision: {
        kind: 'index' as const,
        label: { kind: 'review-marker' as const, text: 'Index' },
      },
    },
    {
      key: 'working',
      maxBytes: 1024,
      path,
      revision: {
        kind: 'working-copy' as const,
        label: { kind: 'review-marker' as const, text: 'Working copy' },
      },
    },
  ];

  const result = await readRevisionContent(directory.path, {
    generation: 'generation-1',
    requests,
    source: { type: 'working-tree' },
  });
  const contents = new Map(
    result.results.flatMap((item) =>
      item.status === 'ready'
        ? [[item.key, new TextDecoder().decode(item.value.bytes)] as const]
        : [],
    ),
  );

  expect(contents).toEqual(
    new Map([
      ['commit', 'committed\n'],
      ['index', 'indexed\n'],
      ['working', 'working\n'],
    ]),
  );
  expect(result.results.map((item) => item.status)).toEqual(['ready', 'ready', 'ready']);
});

test('returns missing coordinates and bounded-read failures per item', async () => {
  await using directory = await createRepository();
  await writeFile(join(directory.path, 'src/large.txt'), 'larger than four bytes');

  const result = await readRevisionContent(directory.path, {
    generation: 'generation-1',
    requests: [
      {
        key: 'missing',
        maxBytes: 1024,
        path: 'src/missing.txt',
        revision: {
          kind: 'working-copy',
          label: { kind: 'review-marker', text: 'Working copy' },
        },
      },
      {
        key: 'large',
        maxBytes: 4,
        path: 'src/large.txt',
        revision: {
          kind: 'working-copy',
          label: { kind: 'review-marker', text: 'Working copy' },
        },
      },
    ],
    source: { type: 'working-tree' },
  });

  expect(result.results).toEqual([
    { key: 'missing', status: 'missing' },
    expect.objectContaining({ key: 'large', status: 'unavailable' }),
  ]);
});

test('uses native Git before GitHub transport and falls back with normalized bytes', async () => {
  await using directory = await createRepository();
  await writeFile(join(directory.path, 'src/native.txt'), 'native\n');
  git(directory.path, 'add', '.');
  git(directory.path, 'commit', '--quiet', '-m', 'Add native file');
  const sha = git(directory.path, 'rev-parse', 'HEAD');
  const transport = {
    request: vi.fn(async () => ({
      content: Buffer.from('provider\n').toString('base64'),
      encoding: 'base64',
      sha: 'b'.repeat(40),
    })),
  };
  const pull = { number: 1, owner: 'example', repo: 'repo' };

  const native = await readGitHubFileBlobArtifacts(
    directory.path,
    pull,
    [{ maxBytes: 1024, path: 'src/native.txt', ref: sha }],
    transport,
  );
  const fallback = await readGitHubFileBlobArtifacts(
    directory.path,
    pull,
    [{ maxBytes: 1024, path: 'src/provider.txt', ref: 'a'.repeat(40) }],
    transport,
  );

  expect(transport.request).toHaveBeenCalledOnce();
  expect(native.get(`${sha}:src/native.txt`)?.provenance.kind).toBe('native-git');
  expect(new TextDecoder().decode(fallback.get(`${'a'.repeat(40)}:src/provider.txt`)?.bytes)).toBe(
    'provider\n',
  );
  expect(fallback.get(`${'a'.repeat(40)}:src/provider.txt`)?.provenance.kind).toBe('github-api');
});

test('normalizes GitLab fallback through the same commit-content adapter shape', async () => {
  await using directory = await createRepository();
  const transport = {
    request: vi.fn(async () => ({
      blob_id: 'c'.repeat(40),
      content: Buffer.from('gitlab\n').toString('base64'),
      encoding: 'base64',
    })),
  };
  const ref = 'd'.repeat(40);
  const result = await readGitLabFileBlobArtifacts(
    directory.path,
    { host: 'gitlab.example.com', projectPath: 'group/project' },
    [{ maxBytes: 1024, path: 'src/provider.txt', ref }],
    transport,
  );
  const blob = result.get(`${ref}:src/provider.txt`);

  expect(new TextDecoder().decode(blob?.bytes)).toBe('gitlab\n');
  expect(blob?.provenance.kind).toBe('gitlab-api');
});

test('rejects provider fallback after the logical review head changes', async () => {
  await using directory = await createRepository();
  const expectedHead = 'a'.repeat(40);
  const transport = {
    request: vi.fn(async () => ({ head: { sha: 'b'.repeat(40) } })),
  };

  await expect(
    readGitHubFileBlobArtifacts(
      directory.path,
      { headSha: expectedHead, number: 1, owner: 'example', repo: 'repo' },
      [{ maxBytes: 1024, path: 'src/provider.txt', ref: expectedHead }],
      transport,
    ),
  ).rejects.toThrow('head changed');
  expect(transport.request).toHaveBeenCalledOnce();
});
