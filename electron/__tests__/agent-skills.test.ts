import {
  renameSync as nodeRenameSync,
  symlinkSync as nodeSymlinkSync,
  unlinkSync as nodeUnlinkSync,
} from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
    successDetail?: string;
    targets: ReadonlyArray<{
      sourceSubdir: string;
      targetSubdir: string;
      type: 'directory' | 'file';
    }>;
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
    fileOperations?: {
      renameSync?: typeof nodeRenameSync;
      symlinkSync?: typeof nodeSymlinkSync;
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
      targets: [
        {
          sourceSubdir: 'codex/skills/codiff',
          targetSubdir: '.codex/skills/codiff',
          type: 'directory',
        },
      ],
    },
    {
      agentLabel: 'Claude Code',
      id: 'claude',
      label: 'Claude Code Integration',
      successDetail:
        'Restart Claude Code with the installed Channel enabled. Codiff can confirm transport write only, not that Claude processed the feedback.',
      targets: [
        {
          sourceSubdir: 'claude/skills/codiff',
          targetSubdir: '.claude/skills/codiff',
          type: 'directory',
        },
        {
          sourceSubdir: 'claude/channel/codiff',
          targetSubdir: '.claude/plugins/codiff-channel',
          type: 'directory',
        },
      ],
    },
    {
      agentLabel: 'Pi',
      id: 'pi',
      label: 'Pi Skill',
      targets: [
        {
          sourceSubdir: 'pi/skills/codiff',
          targetSubdir: '.pi/agent/skills/codiff',
          type: 'directory',
        },
      ],
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
      label: 'OpenCode Integration',
      targets: [
        {
          sourceSubdir: 'opencode/skills/codiff',
          targetSubdir: '.config/opencode/skills/codiff',
          type: 'directory',
        },
        {
          sourceSubdir: 'opencode/plugins/codiff.js',
          targetSubdir: '.config/opencode/plugins/codiff.js',
          type: 'file',
        },
      ],
    },
  ]);
});

test('installs and reports the managed Claude Code Channel without claiming it is active', async () => {
  await using directory = await createTemporaryDirectory('codiff-claude-channel-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const skillSource = join(root, 'claude/skills/codiff');
  const channelSource = join(root, 'claude/channel/codiff');
  const channelTarget = join(home, '.claude/plugins/codiff-channel');
  const skill = listAgentSkills().find(({ id }) => id === 'claude');
  const showMessageBox = vi.fn(async () => {});
  await mkdir(skillSource, { recursive: true });
  await mkdir(channelSource, { recursive: true });
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(true);
  expect(installer.getStatus()).toEqual({
    installed: true,
    path: join(home, '.claude/skills/codiff'),
  });
  await expect(realpath(channelTarget)).resolves.toBe(await realpath(channelSource));
  expect(showMessageBox).toHaveBeenCalledWith(
    expect.objectContaining({
      detail: expect.stringContaining('Codiff can confirm transport write only'),
      message: 'Installed the Codiff Claude Code Integration.',
    }),
  );
  expect(JSON.stringify(showMessageBox.mock.calls)).not.toContain('is active');
});

test('does not replace a user-authored Claude Code Channel target', async () => {
  await using directory = await createTemporaryDirectory('codiff-claude-channel-conflict-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const skillSource = join(root, 'claude/skills/codiff');
  const channelSource = join(root, 'claude/channel/codiff');
  const channelTarget = join(home, '.claude/plugins/codiff-channel');
  const skill = listAgentSkills().find(({ id }) => id === 'claude');
  await mkdir(skillSource, { recursive: true });
  await mkdir(channelSource, { recursive: true });
  await mkdir(channelTarget, { recursive: true });
  await writeFile(join(channelTarget, 'user-file'), 'user-authored\n');
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  await expect(readFile(join(channelTarget, 'user-file'), 'utf8')).resolves.toBe('user-authored\n');
  await expect(lstat(join(home, '.claude/skills/codiff'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('leaves both Claude targets unchanged when staging the second target fails', async () => {
  await using directory = await createTemporaryDirectory('codiff-claude-stage-failure-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const skill = listAgentSkills().find(({ id }) => id === 'claude');
  await mkdir(join(root, 'claude/skills/codiff'), { recursive: true });
  await mkdir(join(root, 'claude/channel/codiff'), { recursive: true });
  let stages = 0;
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    fileOperations: {
      symlinkSync: (source, target, type) => {
        stages += 1;
        if (stages === 2) throw new Error('injected stage failure');
        return nodeSymlinkSync(source, target, type);
      },
    },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  await expect(lstat(join(home, '.claude/skills/codiff'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(lstat(join(home, '.claude/plugins/codiff-channel'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('does not overwrite a Claude target that changes after preflight', async () => {
  await using directory = await createTemporaryDirectory('codiff-claude-revalidation-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const skillTarget = join(home, '.claude/skills/codiff');
  const channelTarget = join(home, '.claude/plugins/codiff-channel');
  const userSource = join(directory.path, 'user-skill');
  const skill = listAgentSkills().find(({ id }) => id === 'claude');
  await mkdir(join(root, 'claude/skills/codiff'), { recursive: true });
  await mkdir(join(root, 'claude/channel/codiff'), { recursive: true });
  await mkdir(userSource, { recursive: true });
  await mkdir(dirname(skillTarget), { recursive: true });
  await mkdir(dirname(channelTarget), { recursive: true });
  await symlink(join(root, 'claude/skills/codiff'), skillTarget, 'dir');
  await symlink(join(root, 'claude/channel/codiff'), channelTarget, 'dir');
  let stages = 0;
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    fileOperations: {
      symlinkSync: (source, target, type) => {
        nodeSymlinkSync(source, target, type);
        stages += 1;
        if (stages === 2) {
          nodeUnlinkSync(skillTarget);
          nodeSymlinkSync(userSource, skillTarget, 'dir');
        }
      },
    },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  expect(await realpath(skillTarget)).toBe(await realpath(userSource));
  expect(await realpath(channelTarget)).toBe(await realpath(join(root, 'claude/channel/codiff')));
});

test('rolls back both Claude targets when committing the second target fails', async () => {
  await using directory = await createTemporaryDirectory('codiff-claude-commit-failure-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const skillTarget = join(home, '.claude/skills/codiff');
  const channelTarget = join(home, '.claude/plugins/codiff-channel');
  const skill = listAgentSkills().find(({ id }) => id === 'claude');
  await mkdir(join(root, 'claude/skills/codiff'), { recursive: true });
  await mkdir(join(root, 'claude/channel/codiff'), { recursive: true });
  await mkdir(dirname(skillTarget), { recursive: true });
  await mkdir(dirname(channelTarget), { recursive: true });
  await symlink(join(root, 'claude/skills/codiff'), skillTarget, 'dir');
  await symlink(join(root, 'claude/channel/codiff'), channelTarget, 'dir');
  const skillIdentity = await lstat(skillTarget);
  const channelIdentity = await lstat(channelTarget);
  let failed = false;
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    fileOperations: {
      renameSync: (source, target) => {
        if (!failed && target === channelTarget && source.includes('.codiff-stage-')) {
          failed = true;
          throw new Error('injected commit failure');
        }
        nodeRenameSync(source, target);
      },
    },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  expect((await lstat(skillTarget)).ino).toBe(skillIdentity.ino);
  expect((await lstat(channelTarget)).ino).toBe(channelIdentity.ino);
  expect(installer.getStatus().installed).toBe(true);
});

test('rolls back OpenCode targets when the later managed file commit fails', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-commit-failure-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const commandTarget = join(home, '.config/opencode/commands/codiff.md');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');
  await mkdir(join(root, 'opencode/skills/codiff'), { recursive: true });
  await mkdir(join(root, 'opencode/plugins'), { recursive: true });
  await mkdir(join(root, 'opencode/commands'), { recursive: true });
  await writeFile(join(root, 'opencode/plugins/codiff.js'), '// managed plugin\n');
  await writeFile(
    join(root, 'opencode/commands/codiff.md'),
    '<!-- codiff-managed-opencode-command:v1 -->\nRun Codiff.\n',
  );
  let failed = false;
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    fileOperations: {
      renameSync: (source, target) => {
        if (!failed && target === commandTarget && source.includes('.codiff-stage-')) {
          failed = true;
          throw new Error('injected managed file failure');
        }
        nodeRenameSync(source, target);
      },
    },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  await expect(lstat(join(home, '.config/opencode/skills/codiff'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(lstat(join(home, '.config/opencode/plugins/codiff.js'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(lstat(commandTarget)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('the managed Claude skill documents the tested Channel startup command', async () => {
  await expect(readFile('claude/skills/codiff/SKILL.md', 'utf8')).resolves.toContain(
    'claude --plugin-dir "$HOME/.claude/plugins/codiff-channel" --dangerously-load-development-channels server:codiff',
  );
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
    expect(document).toContain('CODIFF_REVIEW_RESULT');
    expect(document).toContain('status: "submitted"');
    expect(document).toContain('status: "closed"');
    expect(document).toContain('Address every returned comment');
    expect(document).toContain('Do not automatically reopen Codiff');
    return document.replace(
      /   \*\*Agent integration:\*\*[\s\S]*?(?=\n\n   Codiff validates)/,
      '   **Agent integration:** <agent-specific>',
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
  const pluginSource = join(root, 'opencode/plugins/codiff.js');
  const pluginTarget = join(home, '.config/opencode/plugins/codiff.js');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');
  let model = 'anthropic/claude-sonnet-4-6';

  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'opencode/commands'), { recursive: true });
  await mkdir(join(root, 'opencode/plugins'), { recursive: true });
  await writeFile(pluginSource, 'export const CodiffPlugin = async () => ({});\n');
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
  await expect(realpath(pluginTarget)).resolves.toBe(await realpath(pluginSource));
  await expect(readFile(commandTarget, 'utf8')).resolves.toContain(
    'model: anthropic/claude-sonnet-4-6',
  );
  await expect(installer.install()).resolves.toBe(true);
  await expect(realpath(target)).resolves.toBe(await realpath(source));
  await expect(realpath(pluginTarget)).resolves.toBe(await realpath(pluginSource));

  await rm(pluginTarget);
  expect(installer.getStatus()).toEqual({ installed: false, path: target });
  await expect(installer.install()).resolves.toBe(true);

  await rm(commandTarget);
  expect(installer.getStatus()).toEqual({ installed: false, path: target });
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
  const pluginSource = join(root, 'opencode/plugins/codiff.js');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');

  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'opencode/commands'), { recursive: true });
  await mkdir(join(root, 'opencode/plugins'), { recursive: true });
  await mkdir(join(home, '.config/opencode/commands'), { recursive: true });
  await writeFile(commandSource, '<!-- codiff-managed-opencode-command:v1 -->\nRun Codiff.\n');
  await writeFile(pluginSource, 'export const CodiffPlugin = async () => ({});\n');
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

test('does not replace a user-authored OpenCode plugin', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-plugin-conflict-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const source = join(root, 'opencode/skills/codiff');
  const commandSource = join(root, 'opencode/commands/codiff.md');
  const pluginSource = join(root, 'opencode/plugins/codiff.js');
  const pluginTarget = join(home, '.config/opencode/plugins/codiff.js');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');

  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'opencode/commands'), { recursive: true });
  await mkdir(join(root, 'opencode/plugins'), { recursive: true });
  await mkdir(join(home, '.config/opencode/plugins'), { recursive: true });
  await writeFile(commandSource, '<!-- codiff-managed-opencode-command:v1 -->\nRun Codiff.\n');
  await writeFile(pluginSource, 'export const CodiffPlugin = async () => ({});\n');
  await writeFile(pluginTarget, '// My custom plugin.\n');
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
  await expect(readFile(pluginTarget, 'utf8')).resolves.toBe('// My custom plugin.\n');
  expect(installer.getStatus().installed).toBe(false);
});

test('does not replace an unrelated user-authored OpenCode plugin symlink', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-plugin-link-conflict-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const source = join(root, 'opencode/skills/codiff');
  const commandSource = join(root, 'opencode/commands/codiff.md');
  const pluginSource = join(root, 'opencode/plugins/codiff.js');
  const userPlugin = join(directory.path, 'user-plugin.js');
  const pluginTarget = join(home, '.config/opencode/plugins/codiff.js');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');

  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'opencode/commands'), { recursive: true });
  await mkdir(join(root, 'opencode/plugins'), { recursive: true });
  await mkdir(join(home, '.config/opencode/plugins'), { recursive: true });
  await writeFile(commandSource, '<!-- codiff-managed-opencode-command:v1 -->\nRun Codiff.\n');
  await writeFile(pluginSource, 'export const CodiffPlugin = async () => ({});\n');
  await writeFile(userPlugin, '// User plugin.\n');
  await symlink(userPlugin, pluginTarget, 'file');
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  await expect(realpath(pluginTarget)).resolves.toBe(await realpath(userPlugin));
  await expect(readFile(pluginTarget, 'utf8')).resolves.toBe('// User plugin.\n');
});
