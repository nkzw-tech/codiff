#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const runtimeFiles = [
  'electron/github-history-bridge.cjs',
  'electron/gitlab-history-bridge.cjs',
  'github/dist/index.mjs',
  'gitlab/dist/index.mjs',
];
const builtin = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, npm_config_ignore_scripts: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed: ${Buffer.concat(stderr)}`));
      }
    });
  });

const parsePackEntry = (value) => {
  const entry = Array.isArray(value) ? value[0] : value;
  return Array.isArray(entry?.files) ? new Set(entry.files.map((file) => file.path)) : null;
};

const parsePackList = (output) => {
  try {
    const files = parsePackEntry(JSON.parse(output));
    if (files) {
      return files;
    }
  } catch {
    // pnpm may prefix a JSON payload with informational output.
  }
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const files = parsePackEntry(JSON.parse(line));
      if (files) {
        return files;
      }
    } catch {
      // Continue looking for a one-line JSON payload.
    }
  }
  throw new Error('pnpm pack did not return a JSON package file list.');
};

const nonBuiltinImports = async (path) => {
  const source = await readFile(path, 'utf8');
  const specifiers = [
    ...source.matchAll(
      /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\()\s*["']([^"']+)["']/g,
    ),
    ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  return specifiers.filter(
    (specifier) =>
      specifier &&
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !builtin.has(specifier),
  );
};

const packList = parsePackList(
  await run('pnpm', ['--config.ignore-scripts=true', 'pack', '--dry-run', '--json']),
);
for (const path of runtimeFiles) {
  if (!packList.has(path)) {
    throw new Error(`Root package is missing required runtime artifact ${path}.`);
  }
}
for (const path of ['github/dist/index.mjs', 'gitlab/dist/index.mjs']) {
  const imports = await nonBuiltinImports(join(root, path));
  if (imports.length > 0) {
    throw new Error(`${path} retains non-builtin runtime imports: ${imports.join(', ')}.`);
  }
}

const directory = await mkdtemp(join(tmpdir(), 'codiff-package-runtime-'));
try {
  for (const path of runtimeFiles) {
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, path), destination, { recursive: true });
  }
  const require = createRequire(join(directory, 'package.json'));
  const [{ loadGitHubHistory }, { loadGitLabHistory }] = [
    require(join(directory, 'electron/github-history-bridge.cjs')),
    require(join(directory, 'electron/gitlab-history-bridge.cjs')),
  ];
  const [github, gitlab] = await Promise.all([loadGitHubHistory(), loadGitLabHistory()]);
  if (typeof github.createGitHubArtifactSource !== 'function') {
    throw new Error('GitHub runtime bridge did not load createGitHubArtifactSource.');
  }
  if (typeof gitlab.createGitLabArtifactSource !== 'function') {
    throw new Error('GitLab runtime bridge did not load createGitLabArtifactSource.');
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}
