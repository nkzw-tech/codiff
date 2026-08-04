import { expect, test } from 'vite-plus/test';
import { buildSourceDescriptionModel } from '../lib/source-description.ts';
import type { CommitMetadata, GitSha } from '../types.ts';

const gitSha = (character: string) => character.repeat(40) as GitSha;
const person = {
  date: '2026-08-06T00:00:00.000Z',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
};
const commitMetadata = {
  author: person,
  body: '',
  committer: person,
  files: [],
  parentShas: [],
  refs: [],
  sha: gitSha('a'),
  shortSha: 'aaaaaaa',
  signature: { status: 'unsigned' },
  stats: {
    additions: 0,
    binaryFiles: 0,
    deletions: 0,
    files: 0,
    renamedFiles: 0,
  },
  subject: 'Preserve commit context',
  trailers: [],
} satisfies CommitMetadata;

test('builds commit, missing, title-only, bodyless, and editable source-description models', () => {
  expect(
    buildSourceDescriptionModel({
      commitMetadata,
      source: { sha: gitSha('a'), type: 'commit' },
    }),
  ).toMatchObject({
    author: { displayName: 'Ada Lovelace', title: 'ada@example.com' },
    body: '',
    defaultCollapsed: false,
    kind: 'commit',
    label: 'Commit',
    title: 'Preserve commit context',
  });

  expect(
    buildSourceDescriptionModel({
      commitMetadata: null,
      source: {
        provider: 'github',
        type: 'pull-request',
        url: 'https://github.com/example/repo/pull/1',
      },
    }),
  ).toBeNull();

  expect(
    buildSourceDescriptionModel({
      commitMetadata: null,
      source: {
        provider: 'gitlab',
        title: 'Title only',
        type: 'pull-request',
        url: 'https://gitlab.example.com/example/repo/-/merge_requests/1',
      },
    }),
  ).toMatchObject({
    body: '',
    defaultCollapsed: false,
    kind: 'pull-request',
    label: 'MR description',
    title: 'Title only',
  });

  expect(
    buildSourceDescriptionModel({
      commitMetadata: null,
      source: {
        canEditDescription: true,
        description: '',
        provider: 'github',
        title: 'Editable title',
        type: 'pull-request',
        url: 'https://github.com/example/repo/pull/2',
      },
    }),
  ).toMatchObject({ allowsBodyEdit: true, defaultCollapsed: false });
});

test('keys provider models to immutable head identity', () => {
  const source = {
    description: 'Body',
    headSha: gitSha('a'),
    provider: 'github' as const,
    title: 'Title',
    type: 'pull-request' as const,
    url: 'https://github.com/example/repo/pull/3',
  };
  const first = buildSourceDescriptionModel({ commitMetadata: null, source });
  const second = buildSourceDescriptionModel({
    commitMetadata: null,
    source: { ...source, headSha: gitSha('b') },
  });
  expect(first?.identity).not.toBe(second?.identity);
});
