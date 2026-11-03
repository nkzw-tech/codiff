import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { buildInstallSkillMenuItem, listAgentSkills } = require('../agent-skills.cjs') as {
  buildInstallSkillMenuItem: (install: (skill: { id: string }, browserWindow: unknown) => void) => {
    label: string;
    submenu: Array<{
      click: (menuItem: unknown, browserWindow: unknown) => void;
      label: string;
    }>;
  };
  listAgentSkills: () => ReadonlyArray<{
    agentLabel: string;
    files?: ReadonlyArray<{
      legacyManagedMarkers?: ReadonlyArray<string>;
      managedMarker: string;
      sourceSubdir: string;
      targetSubdir: string;
    }>;
    id: string;
    label: string;
    targets: ReadonlyArray<{ sourceSubdir: string; targetSubdir: string }>;
  }>;
};
const { createSkillInstaller } = require('../main/agent-skill.cjs') as {
  createSkillInstaller: (options: {
    app: {
      getPath: (name: string) => string;
      isPackaged: boolean;
    };
    dialog: {
      showMessageBox: (options: unknown) => Promise<void>;
    };
    renderManagedFile?: (file: { sourceSubdir: string }, template: string) => string;
    root: string;
    skill: ReturnType<typeof listAgentSkills>[number];
  }) => {
    getStatus: () => { installed: boolean; path: string };
    install: () => Promise<boolean>;
    refreshManagedFiles: () => void;
  };
};

test('lists every bundled skill with its installation target', () => {
  expect(listAgentSkills()).toEqual([
    {
      agentLabel: 'Codex',
      id: 'codex',
      label: 'Codex Skill',
      targets: [{ sourceSubdir: 'codex/skills/codiff', targetSubdir: '.codex/skills/codiff' }],
    },
    {
      agentLabel: 'Claude Code',
      id: 'claude',
      label: 'Claude Code Skill',
      targets: [{ sourceSubdir: 'claude/skills/codiff', targetSubdir: '.claude/skills/codiff' }],
    },
    {
      agentLabel: 'Pi',
      id: 'pi',
      label: 'Pi Skill',
      targets: [{ sourceSubdir: 'pi/skills/codiff', targetSubdir: '.pi/agent/skills/codiff' }],
    },
    {
      agentLabel: 'OpenCode',
      files: [
        {
          legacyManagedMarkers: [
            '<!-- Managed by Codiff. Reinstall the OpenCode integration instead of editing this file. -->',
          ],
          managedMarker: '<!-- codiff-managed-opencode-command:v1 -->',
          sourceSubdir: 'opencode/commands/codiff.md',
          targetSubdir: '.config/opencode/commands/codiff.md',
        },
      ],
      id: 'opencode',
      label: 'OpenCode Skill',
      targets: [
        {
          sourceSubdir: 'opencode/skills/codiff',
          targetSubdir: '.config/opencode/skills/codiff',
        },
      ],
    },
  ]);
});

test('builds an Install Skill submenu that routes each agent action', () => {
  const install = vi.fn();
  const menuItem = buildInstallSkillMenuItem(install);
  const browserWindow = {};

  expect(menuItem.label).toBe('Install Skill');
  expect(menuItem.submenu.map((item) => item.label)).toEqual([
    'Codex',
    'Claude Code',
    'Pi',
    'OpenCode',
  ]);

  menuItem.submenu[3].click({}, browserWindow);
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ id: 'opencode' }), browserWindow);
});

test('keeps skill instructions identical outside agent integration details', async () => {
  const paths = [
    'codex/skills/codiff/SKILL.md',
    'claude/skills/codiff/SKILL.md',
    'pi/skills/codiff/SKILL.md',
    'opencode/skills/codiff/SKILL.md',
  ];
  const documents = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  const normalized = documents.map((document) => {
    expect(document).toContain('   **Agent integration:**');
    return document.replace(
      /   \*\*Agent integration:\*\*[\s\S]*?\n\n/,
      '   **Agent integration:** <agent-specific>\n\n',
    );
  });

  expect(new Set(normalized).size).toBe(1);
});

test('installs the OpenCode skill into its global skills directory', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-skill-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const source = join(root, 'opencode/skills/codiff');
  const target = join(home, '.config/opencode/skills/codiff');
  const commandSource = join(root, 'opencode/commands/codiff.md');
  const commandTarget = join(home, '.config/opencode/commands/codiff.md');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');
  let model = 'anthropic/claude-sonnet-4-6';

  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'opencode/commands'), { recursive: true });
  await writeFile(
    commandSource,
    '---\n{{MODEL}}\n---\n<!-- codiff-managed-opencode-command:v1 -->\nRun Codiff.\n',
  );
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: {
      getPath: () => home,
      isPackaged: false,
    },
    dialog: {
      showMessageBox: async () => {},
    },
    renderManagedFile: (_file, template) => template.replace('{{MODEL}}', `model: ${model}`),
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(true);
  expect(installer.getStatus()).toEqual({ installed: true, path: target });
  await expect(realpath(target)).resolves.toBe(await realpath(source));
  await expect(readFile(commandTarget, 'utf8')).resolves.toContain(
    'model: anthropic/claude-sonnet-4-6',
  );

  await rm(commandTarget);
  model = 'openai/gpt-5.5';
  installer.refreshManagedFiles();
  await expect(readFile(commandTarget, 'utf8')).resolves.toContain('model: openai/gpt-5.5');
  expect(installer.getStatus()).toEqual({ installed: true, path: target });
});

test('does not replace a user-authored OpenCode command', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-command-conflict-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const source = join(root, 'opencode/skills/codiff');
  const commandSource = join(root, 'opencode/commands/codiff.md');
  const commandTarget = join(home, '.config/opencode/commands/codiff.md');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');

  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'opencode/commands'), { recursive: true });
  await mkdir(join(home, '.config/opencode/commands'), { recursive: true });
  await writeFile(commandSource, '<!-- codiff-managed-opencode-command:v1 -->\nRun Codiff.\n');
  await writeFile(
    commandTarget,
    '<!-- This user-authored file mentions Managed by Codiff. -->\nMy custom Codiff command.\n',
  );
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: {
      getPath: () => home,
      isPackaged: false,
    },
    dialog: {
      showMessageBox: async () => {},
    },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  await expect(readFile(commandTarget, 'utf8')).resolves.toContain('My custom Codiff command.');
  await expect(lstat(join(home, '.config/opencode/skills/codiff'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('replaces a dangling skill symlink on reinstall', async () => {
  await using directory = await createTemporaryDirectory('codiff-dangling-skill-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const source = join(root, 'claude/skills/codiff');
  const target = join(home, '.claude/skills/codiff');
  const skill = listAgentSkills().find(({ id }) => id === 'claude');

  await mkdir(source, { recursive: true });
  await mkdir(join(home, '.claude/skills'), { recursive: true });
  await symlink(join(directory.path, 'old-app/claude/skills/codiff'), target);
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: {
      getPath: () => home,
      isPackaged: false,
    },
    dialog: {
      showMessageBox: async () => {},
    },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(true);
  await expect(realpath(target)).resolves.toBe(await realpath(source));
});

test('replaces a dangling terminal helper symlink on reinstall', async () => {
  await using directory = await createTemporaryDirectory('codiff-dangling-helper-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const source = join(root, 'bin/codiff.js');
  const target = join(home, '.local/bin/codiff');

  const fs = require('node:fs') as typeof import('node:fs');
  const accessSync = fs.accessSync;
  // Keep the helper out of the real /opt/homebrew/bin and /usr/local/bin.
  const access = vi.spyOn(fs, 'accessSync').mockImplementation((path, mode) => {
    if (path === '/opt/homebrew/bin' || path === '/usr/local/bin') {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    }
    accessSync(path, mode);
  });
  const helperPath = require.resolve('../main/terminal-helper.cjs');
  delete require.cache[helperPath];
  const { createTerminalHelper } = require(helperPath) as {
    createTerminalHelper: (options: {
      app: { getPath: (name: string) => string; isPackaged: boolean };
      dialog: { showMessageBox: (options: unknown) => Promise<void> };
      root: string;
    }) => { installTerminalHelper: (browserWindow?: unknown) => Promise<boolean> };
  };

  try {
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(source, '');
    await mkdir(join(home, '.local/bin'), { recursive: true });
    await symlink(join(directory.path, 'old-app/bin/codiff.js'), target);
    const helper = createTerminalHelper({
      app: { getPath: () => home, isPackaged: false },
      dialog: { showMessageBox: async () => {} },
      root,
    });

    await expect(helper.installTerminalHelper()).resolves.toBe(true);
    await expect(realpath(target)).resolves.toBe(await realpath(source));
  } finally {
    access.mockRestore();
    delete require.cache[helperPath];
  }
});
