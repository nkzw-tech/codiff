import { mkdir, realpath, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { createCodexSkillInstaller } = require('../main/codex-skill.cjs') as {
  createCodexSkillInstaller: (options: {
    app: {
      getPath: (name: string) => string;
      isPackaged: boolean;
    };
    dialog: {
      showMessageBox: (options: unknown) => Promise<void>;
    };
    root: string;
  }) => {
    getCodexSkillStatus: () => { installed: boolean; path: string };
    installCodexSkill: () => Promise<boolean>;
  };
};

test('installs every Codiff Codex skill as a symlink', async () => {
  await using directory = await createTemporaryDirectory('codiff-skill-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const codiffSource = join(root, 'codex/skills/codiff');

  await mkdir(codiffSource, { recursive: true });

  const installer = createCodexSkillInstaller({
    app: {
      getPath: () => home,
      isPackaged: false,
    },
    dialog: {
      showMessageBox: vi.fn(async () => {}),
    },
    root,
  });

  expect(installer.getCodexSkillStatus()).toEqual({
    installed: false,
    path: join(home, '.codex/skills/codiff'),
  });

  await expect(installer.installCodexSkill()).resolves.toBe(true);
  expect(installer.getCodexSkillStatus()).toEqual({
    installed: true,
    path: join(home, '.codex/skills/codiff'),
  });
  await expect(realpath(join(home, '.codex/skills/codiff'))).resolves.toBe(
    await realpath(codiffSource),
  );
});

test('updates stale Codiff Codex skill symlinks', async () => {
  await using directory = await createTemporaryDirectory('codiff-skill-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const codiffSource = join(root, 'codex/skills/codiff');
  const staleSource = join(directory.path, 'stale/codiff');
  const target = join(home, '.codex/skills/codiff');

  await mkdir(codiffSource, { recursive: true });
  await mkdir(staleSource, { recursive: true });
  await mkdir(join(home, '.codex/skills'), { recursive: true });
  await symlink(staleSource, target, 'dir');

  const installer = createCodexSkillInstaller({
    app: {
      getPath: () => home,
      isPackaged: false,
    },
    dialog: {
      showMessageBox: vi.fn(async () => {}),
    },
    root,
  });

  expect(installer.getCodexSkillStatus().installed).toBe(false);
  await expect(installer.installCodexSkill()).resolves.toBe(true);
  await expect(realpath(target)).resolves.toBe(await realpath(codiffSource));
});
