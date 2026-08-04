import { join } from 'node:path';

export const resolveSharedPatch = (root, name) =>
  join(root, 'test-scenarios', 'shared', 'patches', name);

export const initializeNotificationPreferencesRepository = async ({
  baseBranch = 'main',
  root,
  runGit,
}) => {
  try {
    await runGit(['rev-parse', '--verify', 'HEAD']);
    await runGit(['checkout', baseBranch]);
    return;
  } catch {
    // A fresh scenario repository needs the shared baseline commit.
  }
  await runGit(['init', '--quiet']);
  await runGit(['config', 'user.email', 'scenario@example.invalid']);
  await runGit(['config', 'user.name', 'Codiff Scenario']);
  await runGit([
    'apply',
    '--recount',
    '--whitespace=nowarn',
    resolveSharedPatch(root, '000-base.diff'),
  ]);
  await runGit(['add', '--all']);
  await runGit(['commit', '--quiet', '-m', 'Seed notification preferences service']);
  await runGit(['branch', '-M', baseBranch]);
};
