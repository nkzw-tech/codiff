import type { ChangedFile } from '../../types.ts';

type ChangedFileOptions = {
  fingerprint?: string;
  kind?: ChangedFile['sections'][number]['kind'];
  patch?: string;
  status?: ChangedFile['status'];
};

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
      },
    ],
    status,
  }) satisfies ChangedFile;

export const createChangedFileWithPatch = (path: string, patch: string) =>
  createChangedFile(path, { patch });
