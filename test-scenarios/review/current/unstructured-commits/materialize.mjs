import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeNotificationPreferencesRepository,
  resolveSharedPatch,
} from '../../../shared/materialize.mjs';

const scenarioDirectory = dirname(fileURLToPath(import.meta.url));
const updatedScenarioDirectory = join(scenarioDirectory, '..', 'current-commit-stack');

export const unstructuredCommitPatches = [
  {
    patch: '003-preference-audit.diff',
    subject: 'Persist preference update records',
  },
  {
    patch: '001-policy-contract.diff',
    subject: 'Tighten notification input parsing',
  },
  {
    patch: '002-delivery-orchestration.diff',
    subject: 'Add delayed notification delivery',
  },
  {
    patch: '004-lifecycle-verification.diff',
    subject: 'Add preference lifecycle coverage',
  },
  {
    patch: 'current/005-rewrite-orchestration.diff',
    subject: 'Clean up delivery scheduling',
  },
];

export const materializeUnstructuredBucket = async ({
  baseBranch = 'main',
  featureBranch = 'feature/test-scenario',
  onCheckpoint,
  root,
  runGit,
}) => {
  await initializeNotificationPreferencesRepository({ baseBranch, root, runGit });
  await onCheckpoint?.({
    kind: 'base-ready',
    revisions: { base: await runGit(['rev-parse', 'HEAD']) },
  });
  await runGit(['checkout', '-B', featureBranch]);
  const revisions = { base: await runGit(['rev-parse', 'HEAD']) };
  for (const [index, patch] of unstructuredCommitPatches.entries()) {
    await runGit([
      'apply',
      '--recount',
      '--whitespace=nowarn',
      patch.patch.startsWith('current/')
        ? join(updatedScenarioDirectory, 'patches/005-rewrite-orchestration.diff')
        : resolveSharedPatch(root, patch.patch),
    ]);
    await runGit(['add', '--all']);
    await runGit(['commit', '--quiet', '-m', patch.subject]);
    revisions[`bucket-${index + 1}`] = await runGit(['rev-parse', 'HEAD']);
    await onCheckpoint?.({ kind: 'feature-commit', patch, revisions: { ...revisions } });
  }
  return { patches: unstructuredCommitPatches, revisions };
};
