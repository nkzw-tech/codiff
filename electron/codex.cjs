// @ts-check

const { spawn } = require('node:child_process');
const { promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  cleanText,
  findExecutableOnPath,
  isExecutableFile,
  normalizeEnum,
  oneLine,
  parseJSONMessage,
  truncate,
} = require('./agent-shared.cjs');

const CODEX_TIMEOUT_MS = 90_000;
const DEFAULT_OPENAI_MODEL = 'gpt-5.3-codex-spark';
const FALLBACK_OPENAI_MODEL = 'gpt-5.5';
const CODEX_REASONING_EFFORT = 'high';
const CODEX_MACOS_BLOCKED_MESSAGE =
  'macOS blocked the local Codex CLI. Update Codex CLI from the official OpenAI release, then run `codex --version` and try again.';
const CODEX_NOT_FOUND_CODE = 'CODEX_NOT_FOUND';
const CODEX_NOT_FOUND_MESSAGE =
  'Codex CLI was not found. Install Codex and verify `codex --version` works in Terminal. Codiff searches PATH, /opt/homebrew/bin/codex, and /usr/local/bin/codex. If Codex is installed somewhere else, launch Codiff with `CODIFF_CODEX_PATH=/absolute/path/to/codex codiff -w`.';
/**
 * @typedef {{
 *   fallbackModel?: string;
 *   model?: string;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 *   reasoningEffort?: 'low' | 'medium' | 'high';
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
    label: 'Default: GPT-5.3 Codex Spark',
  },
  {
    id: FALLBACK_OPENAI_MODEL,
    label: 'Strong: GPT-5.5',
  },
]);
const OPENAI_MODEL_IDS = new Set(OPENAI_MODELS.map((model) => model.id));
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

/** @param {string} [detail] */
const createCodexNotFoundError = (detail) =>
  Object.assign(
    new Error(detail ? `${CODEX_NOT_FOUND_MESSAGE} ${detail}` : CODEX_NOT_FOUND_MESSAGE),
    {
      code: CODEX_NOT_FOUND_CODE,
    },
  );

const getCodexCommand = () => {
  const codexPath = process.env.CODIFF_CODEX_PATH?.trim();
  if (codexPath) {
    if (isExecutableFile(codexPath)) {
      return codexPath;
    }

    throw createCodexNotFoundError(
      `CODIFF_CODEX_PATH is set to ${JSON.stringify(codexPath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('codex');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex']) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createCodexNotFoundError();
};

/** @param {unknown} error */
const isCodexNotFoundError = (error) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === CODEX_NOT_FOUND_CODE || error.code === 'ENOENT'),
  );

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

  if (isCodexNotFoundError(error)) {
    return CODEX_NOT_FOUND_MESSAGE;
  }

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
  if (isCodexNotFoundError(error)) {
    return createCodexNotFoundError();
  }

  const message = getCodexLaunchErrorMessage(error);
  if (error instanceof Error && message === error.message) {
    return error;
  }

  return new Error(message);
};

/** @param {string} value */
const getCodexStructuredErrorMessage = (value) => {
  const matches = Array.from(value.matchAll(/\bERROR:\s*(\{[^\n]+\})/g));
  for (const match of matches.reverse()) {
    try {
      const payload = JSON.parse(match[1]);
      const message = payload?.error?.message || payload?.message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    } catch {
      // Ignore malformed CLI diagnostics and fall back to the raw stream.
    }
  }

  return null;
};

/** @param {unknown} value @returns {string} */
const normalizeOpenAIModel = (value) =>
  normalizeEnum(value, OPENAI_MODEL_IDS, DEFAULT_OPENAI_MODEL);

/** @param {string} value */
const isOpenAIModelAvailabilityError = (value) =>
  /\b(?:model_not_found|unknown model|invalid model|model is not available|not available for|not supported|does not have access|do not have access|don't have access|access to model|403|404)\b/i.test(
    value,
  );

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
  const reasoningEffort = normalizeEnum(
    options.reasoningEffort,
    CODEX_REASONING_EFFORTS,
    CODEX_REASONING_EFFORT,
  );

  /** @param {string} codexModel @returns {Promise<string>} */
  const invokeCodex = async (codexModel) => {
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

        const codexCommand = getCodexCommand();
        const codexArgs = [
          'exec',
          '-m',
          codexModel,
          '-c',
          `model_reasoning_effort="${reasoningEffort}"`,
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
        ];
        const child = spawn(codexCommand, codexArgs, {
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

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
            const rawMessage = stderr || stdout || stdinError?.message || '';
            const message = oneLine(
              getCodexStructuredErrorMessage(rawMessage) || rawMessage,
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
  CODEX_NOT_FOUND_CODE,
  CODEX_NOT_FOUND_MESSAGE,
  cleanText,
  DEFAULT_OPENAI_MODEL,
  FALLBACK_OPENAI_MODEL,
  getCodexCommand,
  getCodexLaunchErrorMessage,
  isCodexNotFoundError,
  isOpenAIModelAvailabilityError,
  normalizeOpenAIModel,
  normalizeEnum,
  oneLine,
  OPENAI_MODELS,
  parseJSONMessage,
  runCodex,
  truncate,
};
