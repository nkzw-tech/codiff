// @ts-check

const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const { join } = require('node:path');
const {
  buildSchemaReminder,
  createAgentAbortError,
  findExecutableOnPath,
  isExecutableFile,
  listenForAbort,
  normalizeEnum,
  normalizeStructuredOutput,
  oneLine,
} = require('./agent-shared.cjs');

// Pi can take longer than Codex/Claude because it may use read-only repository
// tools before producing a structured answer.
const PI_TIMEOUT_MS = 180_000;
const DEFAULT_PI_MODEL = 'pi-default';
const FALLBACK_PI_MODEL = 'pi-default';
const PI_NOT_FOUND_CODE = 'PI_NOT_FOUND';
const PI_NOT_FOUND_MESSAGE =
  'Pi CLI was not found. Install Pi and verify `pi --version` works in Terminal. Codiff searches PATH, ~/.local/bin/pi, /opt/homebrew/bin/pi, and /usr/local/bin/pi. If Pi is installed somewhere else, launch Codiff with `CODIFF_PI_PATH=/absolute/path/to/pi codiff -w`.';

/**
 * @typedef {{
 *   fallbackModel?: string;
 *   model?: string;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 *   onOutput?: (chunk: string) => void;
 *   onPartialText?: (delta: string) => void;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 * }} PiOptions
 */
/**
 * @typedef {{
 *   id: string;
 *   label: string;
 * }} PiModel
 */

/** @type {ReadonlyArray<PiModel>} */
const PI_MODELS = Object.freeze([{ id: DEFAULT_PI_MODEL, label: 'Pi default' }]);
const PI_MODEL_IDS = new Set(PI_MODELS.map((model) => model.id));

/** @param {string} [detail] */
const createPiNotFoundError = (detail) =>
  Object.assign(new Error(detail ? `${PI_NOT_FOUND_MESSAGE} ${detail}` : PI_NOT_FOUND_MESSAGE), {
    code: PI_NOT_FOUND_CODE,
  });

const getPiCommand = () => {
  const piPath = process.env.CODIFF_PI_PATH?.trim();
  if (piPath) {
    if (isExecutableFile(piPath)) {
      return piPath;
    }

    throw createPiNotFoundError(
      `CODIFF_PI_PATH is set to ${JSON.stringify(piPath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('pi');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.local/bin/pi'),
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createPiNotFoundError();
};

/** @param {unknown} error */
const isPiNotFoundError = (error) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === PI_NOT_FOUND_CODE || error.code === 'ENOENT'),
  );

/** @param {unknown} error */
const getPiLaunchError = (error) => {
  if (isPiNotFoundError(error)) {
    return createPiNotFoundError();
  }

  return error instanceof Error ? error : new Error(String(error ?? ''));
};

/** @param {unknown} value @returns {string} */
const normalizePiModel = (value) => normalizeEnum(value, PI_MODEL_IDS, DEFAULT_PI_MODEL);

/**
 * @param {string} output
 * @param {unknown} schema
 * @returns {string}
 */
const normalizePiOutput = (output, schema) => normalizeStructuredOutput(output, schema, 'Pi');

/**
 * @param {string} repoRoot
 * @param {string} prompt
 * @param {unknown} schema
 * @param {string} [_outputName]
 * @param {string} [timeoutMessage]
 * @param {PiOptions} [options]
 */
const runPi = async (
  repoRoot,
  prompt,
  schema,
  _outputName = 'pi-output.json',
  timeoutMessage = 'Pi timed out.',
  options = {},
) => {
  const model = normalizePiModel(options.model);
  const timeoutMs = options.timeoutMs ?? PI_TIMEOUT_MS;
  const effectivePrompt = `${prompt}${buildSchemaReminder(schema)}`;

  return await /** @type {Promise<string>} */ (
    new Promise((resolve, reject) => {
      let stderr = '';
      /** @type {Error | null} */
      let stdinError = null;
      let stdout = '';
      let finished = false;

      if (options.signal?.aborted) {
        reject(createAgentAbortError());
        return;
      }

      const piCommand = getPiCommand();
      const piArgs = [
        '--print',
        '--no-session',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--tools',
        'read,grep,find,ls',
        ...(model === DEFAULT_PI_MODEL ? [] : ['--model', model]),
      ];
      const child = spawn(piCommand, piArgs, {
        cwd: repoRoot,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          child.kill('SIGTERM');
          reject(new Error(timeoutMessage));
        }
      }, timeoutMs);
      const stopAbortListener = listenForAbort(options.signal, () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          reject(createAgentAbortError());
        }
      });

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        options.onPartialText?.(text);
        options.onOutput?.(text);
      });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        options.onOutput?.(text);
      });
      child.stdin.on('error', (error) => {
        stdinError = error;
      });
      child.on('error', (error) => {
        finished = true;
        clearTimeout(timer);
        stopAbortListener();
        reject(getPiLaunchError(error));
      });
      child.on('close', (code, signal) => {
        stopAbortListener();
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timer);

        if (code !== 0) {
          const message = oneLine(
            stderr || stdout || stdinError?.message,
            signal ? `Pi was terminated by ${signal}.` : `Pi exited with code ${code}.`,
          );
          reject(new Error(message));
          return;
        }

        try {
          resolve(normalizePiOutput(stdout, schema));
        } catch (error) {
          reject(error);
        }
      });

      child.stdin.end(effectivePrompt, () => {});
    })
  );
};

module.exports = {
  DEFAULT_PI_MODEL,
  FALLBACK_PI_MODEL,
  PI_MODELS,
  PI_NOT_FOUND_CODE,
  PI_NOT_FOUND_MESSAGE,
  PI_TIMEOUT_MS,
  getPiCommand,
  isPiNotFoundError,
  normalizePiModel,
  normalizePiOutput,
  runPi,
};
