// @ts-check

const { execFile, spawn } = require('node:child_process');
const { existsSync, promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');

const CODEX_TIMEOUT_MS = 45_000;
const DEFAULT_OPENAI_MODEL = 'gpt-5.3-codex-spark';
const FALLBACK_OPENAI_MODEL = 'gpt-5.3-codex';
const CODEX_REASONING_EFFORT = 'high';
const CODEX_MACOS_BLOCKED_MESSAGE =
  'macOS blocked the local Codex CLI. Update Codex CLI from the official OpenAI release, then run `codex --version` and try again.';
/**
 * @typedef {{
 *   fallbackModel?: string;
 *   model?: string;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 * }} CodexOptions
 */
/**
 * @typedef {{
 *   id: string;
 *   label: string;
 * }} OpenAIModel
 */
/** @type {ReadonlyArray<OpenAIModel>} */
const OPENAI_MODELS = Object.freeze([
  {
    id: DEFAULT_OPENAI_MODEL,
    label: 'Best: GPT-5.3 Codex Spark',
  },
  {
    id: FALLBACK_OPENAI_MODEL,
    label: 'Reliable: GPT-5.3 Codex',
  },
  {
    id: 'gpt-5.5',
    label: 'Latest: GPT-5.5',
  },
]);
const OPENAI_MODEL_IDS = new Set(OPENAI_MODELS.map((model) => model.id));
const execFileAsync = promisify(execFile);
/** @type {Promise<string> | null} */
let codexCommandPromise = null;

const resolveCodexCommand = async () => {
  const shell = process.env.SHELL;
  if (shell) {
    try {
      const { stdout } = await execFileAsync(shell, ['-lc', 'command -v codex'], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      const command = stdout.trim();

      if (command) {
        return command;
      }
    } catch {
      // Fall back to known locations below.
    }
  }

  for (const path of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex']) {
    if (existsSync(path)) {
      return path;
    }
  }

  return 'codex';
};

const getCodexCommand = () => {
  if (process.env.CODIFF_CODEX_PATH) {
    return Promise.resolve(process.env.CODIFF_CODEX_PATH);
  }

  codexCommandPromise ||= resolveCodexCommand();
  return codexCommandPromise;
};

/**
 * @param {unknown} error
 * @param {NodeJS.Platform} [platform]
 */
const getCodexLaunchErrorMessage = (error, platform = process.platform) => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error &&
            typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string'
          ? error.message
          : String(error ?? '');
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  const signal =
    error && typeof error === 'object' && 'signal' in error && typeof error.signal === 'string'
      ? error.signal
      : '';

  if (
    platform === 'darwin' &&
    (code === 'EACCES' ||
      code === 'EPERM' ||
      signal === 'SIGKILL' ||
      /\b(?:contains malware|malware blocked|not opened|will damage your computer|moved to (?:the )?bin|permission denied|operation not permitted)\b/i.test(
        message,
      ))
  ) {
    return message.trim()
      ? `${CODEX_MACOS_BLOCKED_MESSAGE} (${message})`
      : CODEX_MACOS_BLOCKED_MESSAGE;
  }

  return message;
};

/** @param {unknown} error */
const getCodexLaunchError = (error) => {
  const message = getCodexLaunchErrorMessage(error);
  if (error instanceof Error && message === error.message) {
    return error;
  }

  return new Error(message);
};

/** @param {unknown} value @param {string} [fallback] */
const oneLine = (value, fallback = '') =>
  (typeof value === 'string' ? value : fallback).replace(/\s+/g, ' ').trim();

/** @param {string} value @param {number} maxLength */
const truncate = (value, maxLength) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
};

/** @param {unknown} value @param {string} [fallback] */
const cleanText = (value, fallback = '') =>
  oneLine(value, fallback).replace(/\s*\.{3}\[truncated]$/i, '');

/** @template T @param {unknown} value @param {ReadonlySet<T>} allowed @param {T} fallback */
const normalizeEnum = (value, allowed, fallback) =>
  allowed.has(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback;

/** @param {unknown} value @returns {string} */
const normalizeOpenAIModel = (value) =>
  normalizeEnum(value, OPENAI_MODEL_IDS, DEFAULT_OPENAI_MODEL);

/** @param {string} value */
const isOpenAIModelAvailabilityError = (value) =>
  /\b(?:model_not_found|unknown model|invalid model|model is not available|not available for|not supported|does not have access|do not have access|don't have access|access to model|403|404)\b/i.test(
    value,
  );

/** @param {string} message @returns {unknown} */
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

/**
 * @param {string} repoRoot
 * @param {string} prompt
 * @param {unknown} schema
 * @param {string} [outputName]
 * @param {string} [timeoutMessage]
 * @param {CodexOptions} [options]
 */
const runCodex = async (
  repoRoot,
  prompt,
  schema,
  outputName = 'codex-output.json',
  timeoutMessage = 'Codex timed out.',
  options = {},
) => {
  const model = normalizeOpenAIModel(options.model);
  const fallbackModel = normalizeOpenAIModel(options.fallbackModel || FALLBACK_OPENAI_MODEL);

  /** @param {string} codexModel @returns {Promise<string>} */
  const invokeCodex = async (codexModel) => {
    const codexCommand = await getCodexCommand();
    const directory = await fs.mkdtemp(join(tmpdir(), 'codiff-codex-'));
    const outputPath = join(directory, outputName);
    const schemaPath = join(directory, 'schema.json');
    await fs.writeFile(schemaPath, JSON.stringify(schema), 'utf8');

    return await /** @type {Promise<string>} */ (
      new Promise((resolve, reject) => {
        let stderr = '';
        /** @type {Error | null} */
        let stdinError = null;
        let stdout = '';
        let finished = false;

        const child = spawn(
          codexCommand,
          [
            'exec',
            '-m',
            codexModel,
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
          reject(getCodexLaunchError(error));
        });
        child.on('close', async (code, signal) => {
          if (finished) {
            return;
          }

          finished = true;
          clearTimeout(timer);

          if (code !== 0) {
            const message = oneLine(
              stderr || stdout || stdinError?.message,
              signal ? `Codex was terminated by ${signal}.` : `Codex exited with code ${code}.`,
            );
            reject(
              new Error(
                getCodexLaunchErrorMessage({
                  message,
                  signal: signal ?? '',
                }),
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
      })
    ).finally(() => fs.rm(directory, { force: true, recursive: true }).catch(() => {}));
  };

  try {
    return await invokeCodex(model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (model === fallbackModel || !isOpenAIModelAvailabilityError(message)) {
      throw error;
    }

    const response = await invokeCodex(fallbackModel);
    await options.onModelFallback?.(fallbackModel, model);
    return response;
  }
};

module.exports = {
  cleanText,
  DEFAULT_OPENAI_MODEL,
  FALLBACK_OPENAI_MODEL,
  getCodexLaunchErrorMessage,
  isOpenAIModelAvailabilityError,
  normalizeOpenAIModel,
  normalizeEnum,
  oneLine,
  OPENAI_MODELS,
  parseJSONMessage,
  runCodex,
  truncate,
};
