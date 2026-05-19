const { spawn } = require('node:child_process');
const { existsSync, promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const CODEX_TIMEOUT_MS = 45_000;
const CODEX_REASONING_EFFORT = 'high';

const getCodexCommand = () => {
  if (process.env.CODIFF_CODEX_PATH) {
    return process.env.CODIFF_CODEX_PATH;
  }

  for (const path of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex']) {
    if (existsSync(path)) {
      return path;
    }
  }

  return 'codex';
};

const oneLine = (value, fallback = '') =>
  (typeof value === 'string' ? value : fallback).replace(/\s+/g, ' ').trim();

const CODEX_MODEL = oneLine(process.env.CODIFF_CODEX_MODEL);

const truncate = (value, maxLength) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
};

const cleanText = (value, fallback = '') =>
  oneLine(value, fallback).replace(/\s*\.{3}\[truncated]$/i, '');

const normalizeEnum = (value, allowed, fallback) => (allowed.has(value) ? value : fallback);

const parseJSONMessage = (message) => {
  try {
    return JSON.parse(message);
  } catch {
    const match = message.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('Codex did not return JSON.');
    }

    return JSON.parse(match[0]);
  }
};

const runCodex = async (
  repoRoot,
  prompt,
  schema,
  outputName = 'codex-output.json',
  timeoutMessage = 'Codex timed out.',
) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'codiff-codex-'));
  const outputPath = join(directory, outputName);
  const schemaPath = join(directory, 'schema.json');
  await fs.writeFile(schemaPath, JSON.stringify(schema), 'utf8');

  return await new Promise((resolve, reject) => {
    let stderr = '';
    let stdinError = null;
    let stdout = '';
    let finished = false;

    const child = spawn(
      getCodexCommand(),
      [
        'exec',
        ...(CODEX_MODEL ? ['-m', CODEX_MODEL] : []),
        '-c',
        `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
        '--cd',
        repoRoot,
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--ignore-rules',
        '--color',
        'never',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '-',
      ],
      {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        child.kill('SIGTERM');
        reject(new Error(timeoutMessage));
      }
    }, CODEX_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.on('error', (error) => {
      stdinError = error;
    });
    child.on('error', (error) => {
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', async (code) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(
          new Error(
            oneLine(stderr || stdout || stdinError?.message, `Codex exited with code ${code}.`),
          ),
        );
        return;
      }

      try {
        const message = await fs.readFile(outputPath, 'utf8');
        resolve(message);
      } catch {
        resolve(stdout);
      }
    });

    child.stdin.end(prompt, () => {});
  }).finally(() => fs.rm(directory, { force: true, recursive: true }).catch(() => {}));
};

module.exports = {
  cleanText,
  normalizeEnum,
  oneLine,
  parseJSONMessage,
  runCodex,
  truncate,
};
