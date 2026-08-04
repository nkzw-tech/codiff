import { readFile } from 'node:fs/promises';
import { expect, test } from 'vite-plus/test';

test('eval viewer scripts preserve strict ports and documented recovery commands', async () => {
  const [packageManifest, readme, viewShareSource] = await Promise.all([
    readFile('package.json', 'utf8').then(JSON.parse),
    readFile('evals/README.md', 'utf8'),
    readFile('evals/view-share.mjs', 'utf8'),
  ]);

  expect(packageManifest.scripts).toMatchObject({
    'eval:browse': 'node ./evals/browse.mjs',
    'eval:view-provider': 'node ./evals/view-provider.mjs',
    'eval:view-repo': 'node ./evals/view-repo.mjs',
    'eval:view-share': 'node ./evals/view-share.mjs',
  });
  expect(viewShareSource).toContain("'--strictPort'");

  const documentedCommands = readme.replaceAll(/\\\s*\n\s*/g, ' ').replaceAll(/\s+/g, ' ');
  for (const script of ['eval:browse', 'eval:view-provider', 'eval:view-repo', 'eval:view-share']) {
    expect(documentedCommands).toContain(`pnpm ${script}`);
  }
  expect(documentedCommands).toContain('state_path=/tmp/codiff-eval-current-stack-github.json');
  expect(documentedCommands).toContain(
    'pnpm eval:view-provider "$target_path" --state "$state_path" --provider github --create',
  );
  expect(documentedCommands).toContain(
    'pnpm eval:view-provider "$target_path" --state "$state_path" --provider github --cleanup --yes',
  );
  expect(documentedCommands).toContain('Do not delete or overwrite this file if creation fails.');
});
