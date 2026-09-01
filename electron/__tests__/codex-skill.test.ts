import { mkdir, realpath } from 'node:fs/promises';
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
    getCodexSkillStatus: () => Promise<{
      active: boolean;
      detail?: string;
      installed: boolean;
      path: string;
    }>;
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

  await expect(installer.getCodexSkillStatus()).resolves.toEqual({
    active: false,
    detail: 'Codex CLI 0.149.0 or newer with `codex queue` is required.',
    installed: false,
    path: join(home, '.codex/skills/codiff'),
  });

  await expect(installer.installCodexSkill()).resolves.toBe(true);
  await expect(installer.getCodexSkillStatus()).resolves.toEqual({
    active: false,
    detail: 'Codex CLI 0.149.0 or newer with `codex queue` is required.',
    installed: true,
    path: join(home, '.codex/skills/codiff'),
  });
  await expect(realpath(join(home, '.codex/skills/codiff'))).resolves.toBe(
    await realpath(codiffSource),
  );
});
