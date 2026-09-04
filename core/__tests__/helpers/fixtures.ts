import type { ChangedFile, DiffRange, GitSha } from '../../types.ts';

type ChangedFileOptions = {
  fingerprint?: string;
  kind?: ChangedFile['sections'][number]['kind'];
  patch?: string;
  status?: ChangedFile['status'];
};

const commitRevision = (character: string) => ({
  label: { kind: 'commit' as const, text: character.repeat(7) },
  sha: character.repeat(40) as GitSha,
});

const rangeForKind = (kind: ChangedFile['sections'][number]['kind']): DiffRange =>
  kind === 'unstaged'
    ? {
        base: { kind: 'index', label: { kind: 'review-marker', text: 'Index' } },
        head: {
          kind: 'working-copy',
          label: { kind: 'review-marker', text: 'Working copy' },
        },
      }
    : kind === 'staged'
      ? {
          base: commitRevision('a'),
          head: { kind: 'index', label: { kind: 'review-marker', text: 'Index' } },
        }
      : { base: commitRevision('a'), head: commitRevision('b') };

export const createChangedFile = (
  path: string,
  {
    fingerprint = `${path}:1`,
    kind = 'unstaged',
    patch,
    status = 'modified',
  }: ChangedFileOptions = {},
) =>
  ({
    fingerprint,
    path,
    sections: [
      {
        binary: false,
        id: `${path}:${kind}`,
        kind,
        patch: patch ?? `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
        range: rangeForKind(kind),
      },
    ],
    status,
  }) satisfies ChangedFile;

export const createChangedFileWithPatch = (path: string, patch: string) =>
  createChangedFile(path, { patch });
