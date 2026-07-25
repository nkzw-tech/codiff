import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { flagDefinitions, parseArguments } from '../../bin/arguments.js';
import { completionShells, generateCompletionScript } from '../../bin/completions.js';
import { getGitTestEnvironment } from './helpers/git.ts';
import { createTemporaryDirectory } from './helpers/resources.ts';

const execFileAsync = promisify(execFile);

const isInstalled = (command: string) => {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// `git check-ref-format` accepts this as a branch name. `${IFS}` stands in for
// the space a ref cannot contain.
const HOSTILE_REF = '$(touch${IFS}pwned)';

const runCodiff = (args: ReadonlyArray<string>) =>
  execFileAsync(process.execPath, [resolve('bin/codiff.js'), ...args], { encoding: 'utf8' });

test('supports bash, fish and zsh', () => {
  expect(completionShells).toEqual(['bash', 'fish', 'zsh']);
});

test('parses the shell passed to --completions', () => {
  expect(parseArguments(['--completions', 'fish']).completionShell).toBe('fish');
});

test('keeps an unknown shell so the command can report it', () => {
  expect(parseArguments(['--completions', 'nushell']).completionShell).toBe('nushell');
});

test('reports an empty shell when --completions has no value', () => {
  expect(parseArguments(['--completions']).completionShell).toBe('');
});

test('reports no shell when --completions is absent', () => {
  expect(parseArguments([]).completionShell).toBeUndefined();
});

test('refuses to generate a script for an unsupported shell', () => {
  expect(() => generateCompletionScript('nushell')).toThrow(
    'Unsupported shell for completions: nushell.',
  );
});

test('prints the completion script for a supported shell', async () => {
  const { stderr, stdout } = await runCodiff(['--completions', 'fish']);

  expect(stderr).toBe('');
  expect(stdout).toBe(generateCompletionScript('fish'));
});

test('fails with a usable message for an unsupported shell', async () => {
  const error = await runCodiff(['--completions', 'nushell']).catch((error) => error);

  expect(error.code).toBe(1);
  expect(error.stderr).toBe(
    'codiff: unsupported shell for --completions: nushell. Supported shells: bash, fish, zsh.\n',
  );
  expect(error.stdout).toBe('');
});

test('fails when --completions is passed without a shell', async () => {
  const error = await runCodiff(['--completions']).catch((error) => error);

  expect(error.code).toBe(1);
  expect(error.stderr).toBe('codiff: --completions requires a shell: bash, fish, zsh.\n');
  expect(error.stdout).toBe('');
});

test('lists --completions in the help output', async () => {
  const { stdout } = await runCodiff(['--help']);

  expect(stdout).toContain('--completions <bash|fish|zsh>');
});

// `codiff-app` is the helper the packaged app installs on the PATH, so it has to
// serve completions too instead of opening a window.
test('codiff-app prints the completion script for a supported shell', async () => {
  const { stderr, stdout } = await execFileAsync(
    resolve('bin/codiff-app'),
    ['--completions', 'zsh'],
    { encoding: 'utf8', env: { ...process.env, CODIFF_NODE_COMMAND: process.execPath } },
  );

  expect(stderr).toBe('');
  expect(stdout).toBe(generateCompletionScript('zsh'));
});

test('codiff-app lists --completions in the help output', async () => {
  const { stdout } = await execFileAsync(resolve('bin/codiff-app'), ['--help'], {
    encoding: 'utf8',
  });

  expect(stdout).toContain('--completions <bash|fish|zsh>');
});

// Fish declares flags as `-l agent`, bash and zsh as `--agent`.
const flagToken = (shell: string, name: string) => (shell === 'fish' ? `-l ${name}` : `--${name}`);

test.for(completionShells)('completes every documented flag in %s', (shell) => {
  const script = generateCompletionScript(shell);

  for (const { hidden, name } of flagDefinitions) {
    if (!hidden) {
      expect(script).toContain(flagToken(shell, name));
    }
  }
});

// The value each flag completes to is derived from the placeholder in its help
// text, so these pin the mapping: renaming a placeholder has to fail here rather
// than silently drop completion.
test('completes refs for flags documented as taking a ref', () => {
  const script = generateCompletionScript('fish');

  expect(script).toContain("-l branch -x -a '(__codiff_refs)'");
  expect(script).toContain("-l commit -x -a '(__codiff_refs)'");
});

test('completes paths for flags documented as taking a file', () => {
  expect(generateCompletionScript('fish')).toContain('-l plan -r -F');
});

test('completes the documented choices for flags that list them', () => {
  expect(generateCompletionScript('fish')).toContain("-l agent -x -a 'claude codex opencode pi'");
});

test('completes nothing for flags whose value is opaque', () => {
  expect(generateCompletionScript('fish')).toContain(
    "-l claude-session -x -d 'Attach Claude Code session metadata to a walkthrough.'",
  );
});

test.for(completionShells)('keeps hidden flags out of the %s script', (shell) => {
  expect(generateCompletionScript(shell)).not.toContain(flagToken(shell, 'public'));
});

test.for(completionShells)('completes the agent backends in %s', (shell) => {
  const script = generateCompletionScript(shell);

  for (const backend of ['claude', 'codex', 'opencode', 'pi']) {
    expect(script).toContain(backend);
  }
});

test.for(completionShells)('completes git refs for %s', (shell) => {
  expect(generateCompletionScript(shell)).toContain('for-each-ref');
});

// Bash completion has no way to show descriptions; fish and zsh both do.
test.for(completionShells.filter((shell) => shell !== 'bash'))(
  'describes flags with their help text in %s',
  (shell) => {
    expect(generateCompletionScript(shell)).toContain('Review a specific commit.');
  },
);

// Ref names may contain shell metacharacters (`git check-ref-format` allows
// `$(...)` and backticks), so a hostile repository must not be able to run code
// when a user completes in it.
test('does not run ref names while completing them in bash', async () => {
  const { candidates, executed } = await completeWithBash(['codiff', '']);

  expect(executed).toBe(false);
  expect(candidates).toContain(quoteForBash(HOSTILE_REF));
});

test('does not run ref names while completing --branch in bash', async () => {
  const { candidates, executed } = await completeWithBash(['codiff', '--branch', '']);

  expect(executed).toBe(false);
  expect(candidates).toContain(quoteForBash(HOSTILE_REF));
});

test('completes refs for the first argument in bash', async () => {
  const { candidates } = await completeWithBash(['codiff', '']);

  expect(candidates).toContain('main');
});

// `codiff [<ref>] [path]` only takes a path after the ref, so refs must stop
// being offered there and the shell's own path completion takes over.
test('leaves the argument after a ref to path completion in bash', async () => {
  const { candidates } = await completeWithBash(['codiff', 'main', '']);

  expect(candidates).toEqual([]);
});

// A flag that names the review source or a plan leaves only the path argument,
// so refs must stop being offered there too.
test.for([
  ['--branch', 'main'],
  ['--commit', 'HEAD'],
  ['--plan', 'plan.md'],
])('leaves the argument after %s to path completion in bash', async ([flag, value]) => {
  const { candidates } = await completeWithBash(['codiff', flag, value, 'ma']);

  expect(candidates).toEqual([]);
});

test('leaves the argument after an equals-form source flag to path completion in bash', async () => {
  const { candidates } = await completeWithBash(['codiff', '--branch', '=', 'main', 'ma']);

  expect(candidates).toEqual([]);
});

// Bash splits `--agent=codex` on the `=` in COMP_WORDBREAKS, so the flag is two
// words back.
test('completes flag values written with an equals sign in bash', async () => {
  const { candidates } = await completeWithBash(['codiff', '--agent', '=', 'cod']);

  expect(candidates).toEqual(['codex']);
});

test('matches refs against a prefix the shell has already escaped in bash', async () => {
  const { candidates } = await completeWithBash(['codiff', String.raw`\$`]);

  expect(candidates).toContain(quoteForBash(HOSTILE_REF));
});

test('generates a syntactically valid bash script', () => {
  expect(() =>
    execFileSync('bash', ['-n'], {
      encoding: 'utf8',
      input: generateCompletionScript('bash'),
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  ).not.toThrow();
});

// `codiff pr 75 <path>` puts the path in third position, so every argument past
// the first has to complete paths rather than only the second.
test('completes a path for every argument after the ref in zsh', () => {
  const script = generateCompletionScript('zsh');

  expect(script).toContain("'1:ref or path:__codiff_target'");
  expect(script).toContain("'*:path:_files'");
});

test.skipIf(!isInstalled('zsh'))('generates a syntactically valid zsh script', async () => {
  await using directory = await createTemporaryDirectory('codiff-completions-');
  const scriptPath = join(directory.path, '_codiff');
  await writeFile(scriptPath, generateCompletionScript('zsh'));

  await expect(execFileAsync('zsh', ['-n', scriptPath])).resolves.toBeTruthy();
});

test.skipIf(!isInstalled('fish'))('completes flag values in fish', async () => {
  const { candidates } = await completeWithFish('codiff --agent ');

  expect(candidates).toEqual(['claude', 'codex', 'opencode', 'pi']);
});

test.skipIf(!isInstalled('fish'))('completes refs without running them in fish', async () => {
  const { candidates, executed } = await completeWithFish('codiff ');

  expect(executed).toBe(false);
  expect(candidates).toContain(HOSTILE_REF);
  expect(candidates).toContain('main');
});

test.skipIf(!isInstalled('fish'))(
  'stops offering refs once the source is a flag in fish',
  async () => {
    const { candidates } = await completeWithFish('codiff --branch main ');

    expect(candidates).not.toContain('main');
  },
);

// How bash itself renders a word so it survives being typed back on a command
// line; that is the form completion candidates have to take.
const quoteForBash = (text: string) =>
  execFileSync('bash', ['-c', 'printf "%q" "$1"', 'bash', text], { encoding: 'utf8' });

// Complete `words` with the generated bash script inside a repository whose
// branches include one named after a command.
const completeWithBash = (words: ReadonlyArray<string>) =>
  withCompletionRepository('bash', async (repository, scriptPath) => {
    const script = [
      'source "$1"',
      `COMP_WORDS=(${words.map((word) => `'${word}'`).join(' ')})`,
      `COMP_CWORD=${words.length - 1}`,
      '_codiff',
      `printf '%s\\n' "\${COMPREPLY[@]}"`,
    ].join('\n');
    const { stdout } = await execFileAsync('bash', ['-c', script, 'bash', scriptPath], {
      cwd: repository,
      encoding: 'utf8',
    });
    return stdout.split('\n').filter(Boolean);
  });

// Fish reports candidates as `value<tab>description`.
const completeWithFish = (commandLine: string) =>
  withCompletionRepository('fish', async (repository, scriptPath) => {
    const { stdout } = await execFileAsync(
      'fish',
      [
        // Without `--no-config` the user's own fish configuration runs first and
        // can move the shell out of the repository.
        '--no-config',
        '-c',
        `source ${JSON.stringify(scriptPath)}; complete -C ${JSON.stringify(commandLine)}`,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')[0]);
  });

async function withCompletionRepository(
  shell: string,
  complete: (repository: string, scriptPath: string) => Promise<ReadonlyArray<string>>,
) {
  await using directory = await createTemporaryDirectory('codiff-completions-');
  const repository = directory.path;
  const git = (args: ReadonlyArray<string>) =>
    execFileAsync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      env: getGitTestEnvironment(),
    });

  await git(['init', '--initial-branch', 'main']);
  await git(['commit', '--allow-empty', '-m', 'Initial commit']);
  await git(['branch', HOSTILE_REF]);

  const scriptPath = join(repository, `completions.${shell}`);
  await writeFile(scriptPath, generateCompletionScript(shell));

  return {
    candidates: await complete(repository, scriptPath),
    executed: existsSync(join(repository, 'pwned')),
  };
}
