import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';

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
  const directory = await mkdtemp(join(tmpdir(), 'codiff-skill-'));
  const home = join(directory, 'home');
  const root = join(directory, 'app');
  const codiffSource = join(root, 'codex/skills/codiff');
  const walkthroughSource = join(root, 'codex/skills/walkthrough');

  try {
    await mkdir(codiffSource, { recursive: true });
    await mkdir(walkthroughSource, { recursive: true });

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

    // Status reports installed only once *all* skills are linked; path is the first.
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
    await expect(realpath(join(home, '.codex/skills/walkthrough'))).resolves.toBe(
      await realpath(walkthroughSource),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('updates stale Codiff Codex skill symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-skill-'));
  const home = join(directory, 'home');
  const root = join(directory, 'app');
  const codiffSource = join(root, 'codex/skills/codiff');
  const walkthroughSource = join(root, 'codex/skills/walkthrough');
  const staleSource = join(directory, 'stale/codiff');
  const target = join(home, '.codex/skills/codiff');

  try {
    await mkdir(codiffSource, { recursive: true });
    await mkdir(walkthroughSource, { recursive: true });
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
    await expect(realpath(join(home, '.codex/skills/walkthrough'))).resolves.toBe(
      await realpath(walkthroughSource),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
