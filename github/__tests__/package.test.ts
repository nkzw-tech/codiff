import { execFileSync } from 'node:child_process';
import { expect, test } from 'vite-plus/test';
import corePackageJson from '../../core/package.json' with { type: 'json' };
import gitlabPackageJson from '../../gitlab/package.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };

const packedFiles = (directory: string) => {
  const output = execFileSync(
    'pnpm',
    ['--dir', directory, '--config.ignore-scripts=true', 'pack', '--dry-run', '--json'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return new Set<string>(entry.files.map((file: { path: string }) => file.path));
};

const sourceTargets = (manifest: { exports: Record<string, Record<string, string>> }) =>
  Object.values(manifest.exports).flatMap((entry) => {
    const target = entry['@nkzw/codiff-source'];
    return target ? [target.replace(/^\.\//, '')] : [];
  });

test('public TypeScript entries resolve to the emitted declarations', () => {
  expect(packageJson.types).toBe('./dist/index.d.ts');
  expect(packageJson.exports['.'].types).toBe('./dist/index.d.ts');
  expect(packageJson.exports['.']['@nkzw/codiff-source']).toBe('./src/index.ts');
});

test('packed provider packages contain every advertised source-condition target', () => {
  const coreFiles = packedFiles('core');
  const gitlabFiles = packedFiles('gitlab');

  for (const target of sourceTargets(corePackageJson)) {
    expect(coreFiles.has(target), `Core package is missing ${target}`).toBe(true);
  }
  for (const target of sourceTargets(gitlabPackageJson)) {
    expect(gitlabFiles.has(target), `GitLab package is missing ${target}`).toBe(true);
  }
});
