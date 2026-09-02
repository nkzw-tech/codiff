import {
  linkSync as nodeLinkSync,
  renameSync as nodeRenameSync,
  symlinkSync as nodeSymlinkSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
      legacyManagedSourceSubdirs?: ReadonlyArray<string>;
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
      linkSync?: typeof nodeLinkSync;
      renameSync?: typeof nodeRenameSync;
      symlinkSync?: typeof nodeSymlinkSync;
    };
    getActiveStatus?: (skillId: string) => Promise<boolean>;
    renderManagedFile?: (
      file: { sourceSubdir: string },
      template: string,
      sourcePath: string,
    ) => string;
    root: string;
    skill: ReturnType<typeof listAgentSkills>[number];
  }) => {
    getStatus: () => Promise<{
      active: boolean;
      detail?: string;
      installed: boolean;
      path: string;
    }>;
    install: () => Promise<boolean>;
    refreshManagedFiles: () => void;
  };
};

const inactiveDetails = {
  claude: 'Restart Claude Code with the Codiff Channel enabled.',
  codex: 'Codex CLI 0.149.0 or newer with `codex queue` is required.',
  opencode: 'Restart OpenCode so the Codiff plugin can register this session.',
  pi: 'Restart Pi so the Codiff extension can register this session.',
};

const openCodeCommand = '<!-- codiff-managed-opencode-command:v1 -->\nRun Codiff.\n';
const openCodePlugin = 'export const CodiffPlugin = async (input) => input;\n';
const openCodeWrapper =
  "// codiff-managed-opencode-plugin:v1\nimport { CodiffPlugin as PackagedCodiffPlugin } from '{{CODIFF_OPENCODE_PLUGIN_URL}}';\nexport const CodiffPlugin = (input) => PackagedCodiffPlugin({ ...input, worktree: input.directory });\n";
const createOpenCodeSources = async (root: string, command = openCodeCommand) => {
  await mkdir(join(root, 'opencode/skills/codiff'), { recursive: true });
  await mkdir(join(root, 'opencode/plugins'), { recursive: true });
  await mkdir(join(root, 'opencode/commands'), { recursive: true });
  await writeFile(join(root, 'opencode/plugins/codiff.js'), openCodePlugin);
  await writeFile(join(root, 'opencode/plugins/codiff-wrapper.js'), openCodeWrapper);
  await writeFile(join(root, 'opencode/commands/codiff.md'), command);
};
const renderOpenCodeManagedFile = (
  file: { sourceSubdir: string },
  template: string,
  sourcePath: string,
) =>
  file.sourceSubdir === 'opencode/plugins/codiff-wrapper.js'
    ? template.replace(
        "'{{CODIFF_OPENCODE_PLUGIN_URL}}'",
        JSON.stringify(pathToFileURL(join(dirname(sourcePath), 'codiff.js')).href),
      )
    : template;

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
      label: 'Pi Integration',
      successDetail:
        'Restart Pi to enable the installed extension. Codiff confirms dispatch started, not that Pi processed the feedback.',
      targets: [
        {
          sourceSubdir: 'pi/skills/codiff',
          targetSubdir: '.pi/agent/skills/codiff',
          type: 'directory',
        },
        {
          sourceSubdir: 'pi/extensions/codiff',
          targetSubdir: '.pi/agent/extensions/codiff',
          type: 'directory',
        },
      ],
    },
    {
      agentLabel: 'OpenCode',
      files: [
        {
          legacyManagedSourceSubdirs: ['opencode/plugins/codiff.js'],
          managedMarker: '// codiff-managed-opencode-plugin:v1',
          sourceSubdir: 'opencode/plugins/codiff-wrapper.js',
          targetSubdir: '.config/opencode/plugins/codiff.js',
        },
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
      ],
    },
  ]);
});

test.each(listAgentSkills())(
  '$id status separates installed files from active delivery',
  async (skill) => {
    await using directory = await createTemporaryDirectory(`codiff-${skill.id}-status-`);
    const getActiveStatus = vi.fn(async () => false);
    const home = join(directory.path, 'home');
    const installer = createSkillInstaller({
      app: { getPath: () => home, isPackaged: false },
      dialog: { showMessageBox: async () => {} },
      getActiveStatus,
      root: join(directory.path, 'app'),
      skill,
    });

    await expect(installer.getStatus()).resolves.toEqual({
      active: false,
      detail: inactiveDetails[skill.id as keyof typeof inactiveDetails],
      installed: false,
      path: join(home, skill.targets[0].targetSubdir),
    });
    expect(getActiveStatus).toHaveBeenCalledWith(skill.id);
  },
);

test('active delivery omits restart guidance independently of installed files', async () => {
  await using directory = await createTemporaryDirectory('codiff-active-status-');
  const skill = listAgentSkills()[0];
  const installer = createSkillInstaller({
    app: { getPath: () => directory.path, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    getActiveStatus: async () => true,
    root: join(directory.path, 'app'),
    skill,
  });

  await expect(installer.getStatus()).resolves.toEqual({
    active: true,
    installed: false,
    path: join(directory.path, skill.targets[0].targetSubdir),
  });
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
  await expect(installer.getStatus()).resolves.toMatchObject({
    active: false,
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

test('installs and reports the managed Pi extension with dispatch-started disclosure', async () => {
  await using directory = await createTemporaryDirectory('codiff-pi-extension-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const skillSource = join(root, 'pi/skills/codiff');
  const extensionSource = join(root, 'pi/extensions/codiff');
  const extensionTarget = join(home, '.pi/agent/extensions/codiff');
  const skill = listAgentSkills().find(({ id }) => id === 'pi');
  const showMessageBox = vi.fn(async () => {});
  await mkdir(skillSource, { recursive: true });
  await mkdir(extensionSource, { recursive: true });
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(true);
  await expect(installer.getStatus()).resolves.toMatchObject({
    active: false,
    installed: true,
    path: join(home, '.pi/agent/skills/codiff'),
  });
  await expect(realpath(extensionTarget)).resolves.toBe(await realpath(extensionSource));
  expect(showMessageBox).toHaveBeenCalledWith(
    expect.objectContaining({
      detail: expect.stringContaining('dispatch started, not that Pi processed'),
      message: 'Installed the Codiff Pi Integration.',
    }),
  );
});

test('does not replace a user-authored Pi extension target', async () => {
  await using directory = await createTemporaryDirectory('codiff-pi-extension-conflict-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const extensionTarget = join(home, '.pi/agent/extensions/codiff');
  const skill = listAgentSkills().find(({ id }) => id === 'pi');
  await mkdir(join(root, 'pi/skills/codiff'), { recursive: true });
  await mkdir(join(root, 'pi/extensions/codiff'), { recursive: true });
  await mkdir(extensionTarget, { recursive: true });
  await writeFile(join(extensionTarget, 'user-file'), 'user-authored\n');
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  await expect(readFile(join(extensionTarget, 'user-file'), 'utf8')).resolves.toBe(
    'user-authored\n',
  );
  await expect(lstat(join(home, '.pi/agent/skills/codiff'))).rejects.toMatchObject({
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
      symlinkSync: (source, target, type) => {
        if (!failed && target === channelTarget) {
          failed = true;
          throw new Error('injected commit failure');
        }
        nodeSymlinkSync(source, target, type);
      },
    },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  expect((await lstat(skillTarget)).ino).toBe(skillIdentity.ino);
  expect((await lstat(channelTarget)).ino).toBe(channelIdentity.ino);
  expect((await installer.getStatus()).installed).toBe(true);
});

test('preserves a user symlink created after backing up a Claude target', async () => {
  await using directory = await createTemporaryDirectory('codiff-claude-backup-race-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const skillTarget = join(home, '.claude/skills/codiff');
  const channelTarget = join(home, '.claude/plugins/codiff-channel');
  const userSource = join(directory.path, 'user-channel');
  const skill = listAgentSkills().find(({ id }) => id === 'claude');
  const showMessageBox = vi.fn(async () => {});
  await mkdir(join(root, 'claude/skills/codiff'), { recursive: true });
  await mkdir(join(root, 'claude/channel/codiff'), { recursive: true });
  await mkdir(userSource, { recursive: true });
  await mkdir(dirname(skillTarget), { recursive: true });
  await mkdir(dirname(channelTarget), { recursive: true });
  await symlink(join(root, 'claude/skills/codiff'), skillTarget, 'dir');
  await symlink(join(root, 'claude/channel/codiff'), channelTarget, 'dir');
  const skillIdentity = await lstat(skillTarget);
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox },
    fileOperations: {
      renameSync: (source, target) => {
        nodeRenameSync(source, target);
        if (source === channelTarget && target.includes('.codiff-backup-')) {
          nodeSymlinkSync(userSource, channelTarget, 'dir');
        }
      },
    },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  expect(await readlink(channelTarget)).toBe(userSource);
  expect((await lstat(channelTarget)).isSymbolicLink()).toBe(true);
  expect((await lstat(skillTarget)).ino).toBe(skillIdentity.ino);
  expect(showMessageBox).toHaveBeenCalledWith(
    expect.objectContaining({ detail: expect.stringContaining('EEXIST') }),
  );
});

test('rolls back OpenCode targets when the later managed file commit fails', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-commit-failure-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const commandTarget = join(home, '.config/opencode/commands/codiff.md');
  const pluginSource = join(root, 'opencode/plugins/codiff.js');
  const pluginTarget = join(home, '.config/opencode/plugins/codiff.js');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');
  await createOpenCodeSources(root);
  await mkdir(dirname(pluginTarget), { recursive: true });
  await symlink(pluginSource, pluginTarget, 'file');
  let failed = false;
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    fileOperations: {
      linkSync: (source, target) => {
        if (!failed && target === commandTarget) {
          failed = true;
          throw new Error('injected managed file failure');
        }
        nodeLinkSync(source, target);
      },
    },
    renderManagedFile: renderOpenCodeManagedFile,
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  await expect(lstat(join(home, '.config/opencode/skills/codiff'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect((await lstat(pluginTarget)).isSymbolicLink()).toBe(true);
  await expect(realpath(pluginTarget)).resolves.toBe(await realpath(pluginSource));
  await expect(lstat(commandTarget)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('preserves a user file created after backing up an OpenCode managed file', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-backup-race-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const skillTarget = join(home, '.config/opencode/skills/codiff');
  const pluginTarget = join(home, '.config/opencode/plugins/codiff.js');
  const commandTarget = join(home, '.config/opencode/commands/codiff.md');
  const userContents = Buffer.from('user-authored command\nwith exact bytes\0\xff', 'latin1');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');
  const showMessageBox = vi.fn(async () => {});
  await createOpenCodeSources(root);
  expect(skill).toBeDefined();
  const initialInstaller = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    renderManagedFile: renderOpenCodeManagedFile,
    root,
    skill: skill!,
  });
  await expect(initialInstaller.install()).resolves.toBe(true);
  const skillIdentity = await lstat(skillTarget);
  const pluginIdentity = await lstat(pluginTarget);
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox },
    fileOperations: {
      renameSync: (source, target) => {
        nodeRenameSync(source, target);
        if (source === commandTarget && target.includes('.codiff-backup-')) {
          nodeWriteFileSync(commandTarget, userContents, { flag: 'wx' });
        }
      },
    },
    renderManagedFile: renderOpenCodeManagedFile,
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  expect(await readFile(commandTarget)).toEqual(userContents);
  expect((await lstat(skillTarget)).ino).toBe(skillIdentity.ino);
  expect((await lstat(pluginTarget)).ino).toBe(pluginIdentity.ino);
  expect(showMessageBox).toHaveBeenCalledWith(
    expect.objectContaining({ detail: expect.stringContaining('EEXIST') }),
  );
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

test('keeps asynchronous review instructions identical outside agent integration details', async () => {
  const paths = [
    'codex/skills/codiff/SKILL.md',
    'claude/skills/codiff/SKILL.md',
    'pi/skills/codiff/SKILL.md',
    'opencode/skills/codiff/SKILL.md',
  ];
  const documents = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  const normalized = documents.map((document) => {
    const normalizedDocument = document.replaceAll(/\s+/g, ' ');
    const desktopInstructions = document.match(/   Desktop mode:[\s\S]*?(?=\n   Share mode:)/)?.[0];
    expect(desktopInstructions).toBeDefined();
    expect(document).toContain('   **Agent integration:**');
    expect(normalizedDocument).toContain(
      'Codiff opened. Review feedback will arrive as a separate message',
    );
    expect(normalizedDocument).toContain('Stop waiting once it prints the open confirmation');
    expect(normalizedDocument).toContain(
      'When Codiff later sends review feedback, treat it as a new user request in this same session. Address every comment in order. Do not automatically reopen Codiff after handling the feedback.',
    );
    expect(desktopInstructions).not.toContain('status: "submitted"');
    expect(desktopInstructions).not.toContain('status: "closed"');
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
  const commandTarget = join(home, '.config/opencode/commands/codiff.md');
  const pluginSource = join(root, 'opencode/plugins/codiff.js');
  const wrapperSource = join(root, 'opencode/plugins/codiff-wrapper.js');
  const pluginTarget = join(home, '.config/opencode/plugins/codiff.js');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');
  let model = 'anthropic/claude-sonnet-4-6';

  await createOpenCodeSources(
    root,
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
    renderManagedFile: (file, template, sourcePath) =>
      file.sourceSubdir === 'opencode/plugins/codiff-wrapper.js'
        ? renderOpenCodeManagedFile(file, template, sourcePath)
        : template.replace('{{MODEL}}', `model: ${model}`),
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(true);
  await expect(installer.getStatus()).resolves.toMatchObject({ installed: true, path: target });
  await expect(realpath(target)).resolves.toBe(await realpath(source));
  expect((await lstat(pluginTarget)).isFile()).toBe(true);
  expect((await lstat(pluginTarget)).isSymbolicLink()).toBe(false);
  await expect(readFile(pluginTarget, 'utf8')).resolves.toContain(
    '// codiff-managed-opencode-plugin:v1',
  );
  await expect(readFile(pluginTarget, 'utf8')).resolves.toContain(pathToFileURL(pluginSource).href);
  await expect(readFile(commandTarget, 'utf8')).resolves.toContain(
    'model: anthropic/claude-sonnet-4-6',
  );
  await expect(installer.install()).resolves.toBe(true);
  await expect(realpath(target)).resolves.toBe(await realpath(source));
  expect((await lstat(pluginTarget)).isFile()).toBe(true);

  await rm(pluginTarget);
  await expect(installer.getStatus()).resolves.toMatchObject({ installed: false, path: target });
  await expect(installer.install()).resolves.toBe(true);

  await rm(commandTarget);
  await expect(installer.getStatus()).resolves.toMatchObject({ installed: false, path: target });
  model = 'openai/gpt-5.5';
  installer.refreshManagedFiles();
  await expect(readFile(commandTarget, 'utf8')).resolves.toContain('model: openai/gpt-5.5');
  await writeFile(wrapperSource, `${openCodeWrapper}// refreshed wrapper\n`);
  installer.refreshManagedFiles();
  await expect(readFile(pluginTarget, 'utf8')).resolves.toContain('// refreshed wrapper');
  await expect(installer.getStatus()).resolves.toMatchObject({ installed: true, path: target });
});

test('migrates the exact legacy Codiff OpenCode plugin symlink', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-plugin-migration-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const pluginSource = join(root, 'opencode/plugins/codiff.js');
  const pluginTarget = join(home, '.config/opencode/plugins/codiff.js');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode')!;

  await createOpenCodeSources(root);
  await mkdir(dirname(pluginTarget), { recursive: true });
  await symlink(pluginSource, pluginTarget, 'file');
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    renderManagedFile: renderOpenCodeManagedFile,
    root,
    skill,
  });

  await expect(installer.install()).resolves.toBe(true);
  expect((await lstat(pluginTarget)).isFile()).toBe(true);
  expect((await lstat(pluginTarget)).isSymbolicLink()).toBe(false);
  await expect(readFile(pluginTarget, 'utf8')).resolves.toContain(pathToFileURL(pluginSource).href);
});

test('does not replace a user-authored OpenCode command', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-command-conflict-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const commandTarget = join(home, '.config/opencode/commands/codiff.md');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');

  await createOpenCodeSources(root);
  await mkdir(join(home, '.config/opencode/commands'), { recursive: true });
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
    renderManagedFile: renderOpenCodeManagedFile,
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
  const pluginTarget = join(home, '.config/opencode/plugins/codiff.js');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');

  await createOpenCodeSources(root);
  await mkdir(join(home, '.config/opencode/plugins'), { recursive: true });
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
    renderManagedFile: renderOpenCodeManagedFile,
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  await expect(readFile(pluginTarget, 'utf8')).resolves.toBe('// My custom plugin.\n');
  expect((await installer.getStatus()).installed).toBe(false);
});

test('does not replace an unrelated user-authored OpenCode plugin symlink', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-plugin-link-conflict-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const userPlugin = join(directory.path, 'user-plugin.js');
  const pluginTarget = join(home, '.config/opencode/plugins/codiff.js');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');

  await createOpenCodeSources(root);
  await mkdir(join(home, '.config/opencode/plugins'), { recursive: true });
  await writeFile(userPlugin, '// User plugin.\n');
  await symlink(userPlugin, pluginTarget, 'file');
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    renderManagedFile: renderOpenCodeManagedFile,
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  await expect(realpath(pluginTarget)).resolves.toBe(await realpath(userPlugin));
  await expect(readFile(pluginTarget, 'utf8')).resolves.toBe('// User plugin.\n');
});

test('does not write through a dangling OpenCode plugin symlink during refresh', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-dangling-plugin-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const pluginTarget = join(home, '.config/opencode/plugins/codiff.js');
  const danglingTarget = join(directory.path, 'missing/user-plugin.js');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode')!;

  await createOpenCodeSources(root);
  const installer = createSkillInstaller({
    app: { getPath: () => home, isPackaged: false },
    dialog: { showMessageBox: async () => {} },
    renderManagedFile: renderOpenCodeManagedFile,
    root,
    skill,
  });
  await expect(installer.install()).resolves.toBe(true);
  await rm(pluginTarget);
  await symlink(danglingTarget, pluginTarget, 'file');

  installer.refreshManagedFiles();

  expect((await lstat(pluginTarget)).isSymbolicLink()).toBe(true);
  await expect(readlink(pluginTarget)).resolves.toBe(danglingTarget);
  await expect(lstat(danglingTarget)).rejects.toMatchObject({ code: 'ENOENT' });
});
