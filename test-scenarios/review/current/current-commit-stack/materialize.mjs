import {
  initializeNotificationPreferencesRepository,
  resolveSharedPatch,
} from '../../../shared/materialize.mjs';

export const currentCommitStackPatches = [
  {
    id: 'policy-contract',
    patch: '001-policy-contract.diff',
    subject: 'Define quiet-hour preference policy',
  },
  {
    id: 'delivery-orchestration',
    patch: '002-delivery-orchestration.diff',
    subject: 'Schedule preference deliveries around quiet hours',
  },
  {
    id: 'preference-audit',
    patch: '003-preference-audit.diff',
    subject: 'Record preference update audit history',
  },
  {
    id: 'lifecycle-verification',
    patch: '004-lifecycle-verification.diff',
    subject: 'Verify preference update lifecycle',
  },
];

export const materializeCurrentCommitStack = async ({
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
  for (const patch of currentCommitStackPatches) {
    await runGit([
      'apply',
      '--recount',
      '--whitespace=nowarn',
      resolveSharedPatch(root, patch.patch),
    ]);
    await runGit(['add', '--all']);
    await runGit(['commit', '--quiet', '-m', patch.subject]);
    revisions[patch.id] = await runGit(['rev-parse', 'HEAD']);
    await onCheckpoint?.({ kind: 'feature-commit', patch, revisions: { ...revisions } });
  }
  return { patches: currentCommitStackPatches, revisions };
};
