import type { DiffRange, GitSha, Revision } from '../types.ts';

export const isCommitRevision = (
  revision: Revision,
): revision is Extract<Revision, { kind?: 'commit' }> =>
  revision.kind !== 'index' && revision.kind !== 'working-copy';

export const shaForRevision = (revision: Revision): GitSha => {
  if (!isCommitRevision(revision)) {
    throw new Error(`Expected a commit revision, received ${revision.kind}.`);
  }
  return revision.sha;
};

export const diffRange = (base: Revision, head: Revision): DiffRange => ({ base, head });
