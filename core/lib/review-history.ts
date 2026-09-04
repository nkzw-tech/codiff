import type { DiffRange, GitSha, Revision } from '../types.ts';

export const isCommitRevision = (
  revision: Revision | null,
): revision is Extract<Revision, { kind?: 'commit' }> =>
  revision != null && revision.kind !== 'index' && revision.kind !== 'working-copy';

export const shaForRevision = (revision: Revision | null): GitSha => {
  if (!isCommitRevision(revision)) {
    throw new Error(`Expected a commit revision, received ${revision?.kind ?? 'an absent side'}.`);
  }
  return revision.sha;
};

export const diffRange = (base: Revision | null, head: Revision | null): DiffRange => ({
  base,
  head,
});
