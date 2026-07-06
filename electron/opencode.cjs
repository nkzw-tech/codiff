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
  normalizeStructuredOutput,
  oneLine,
} = require('./agent-shared.cjs');

const OPENCODE_TIMEOUT_MS = 300_000;
const DEFAULT_OPENCODE_MODEL = 'opencode-default';
const FALLBACK_OPENCODE_MODEL = DEFAULT_OPENCODE_MODEL;
const OPENCODE_COMMAND_MODEL_PLACEHOLDER = '{{CODIFF_OPENCODE_MODEL}}';
const OPENCODE_NOT_FOUND_CODE = 'OPENCODE_NOT_FOUND';
const OPENCODE_NOT_FOUND_MESSAGE =
  'OpenCode CLI was not found. Install OpenCode and verify `opencode --version` works in Terminal. Codiff searches PATH, ~/.opencode/bin/opencode, /opt/homebrew/bin/opencode, and /usr/local/bin/opencode. If OpenCode is installed somewhere else, launch Codiff with `CODIFF_OPENCODE_PATH=/absolute/path/to/opencode codiff -w`.';

/** @type {ReadonlyArray<{id: string; label: string}>} */
const OPENCODE_MODELS = Object.freeze([
  { id: DEFAULT_OPENCODE_MODEL, label: 'OpenCode configured default' },
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
]);
const OPENCODE_MODEL_PATTERN = /^[a-z0-9][a-z0-9._:-]*(?:\/[@a-z0-9][@a-z0-9._:-]*)+$/i;

/** @param {string} [detail] */
const createOpenCodeNotFoundError = (detail) =>
  Object.assign(
    new Error(detail ? `${OPENCODE_NOT_FOUND_MESSAGE} ${detail}` : OPENCODE_NOT_FOUND_MESSAGE),
    { code: OPENCODE_NOT_FOUND_CODE },
  );

const getOpenCodeCommand = () => {
  const opencodePath = process.env.CODIFF_OPENCODE_PATH?.trim();
  if (opencodePath) {
    if (isExecutableFile(opencodePath)) {
      return opencodePath;
    }

    throw createOpenCodeNotFoundError(
      `CODIFF_OPENCODE_PATH is set to ${JSON.stringify(opencodePath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('opencode');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.opencode/bin/opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createOpenCodeNotFoundError();
};

/** @param {unknown} error */
const isOpenCodeNotFoundError = (error) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === OPENCODE_NOT_FOUND_CODE || error.code === 'ENOENT'),
  );

/** @param {unknown} error */
const getOpenCodeLaunchError = (error) => {
  if (isOpenCodeNotFoundError(error)) {
    return createOpenCodeNotFoundError();
  }

  return error instanceof Error ? error : new Error(String(error ?? ''));
};

/** @param {unknown} value @returns {string} */
const normalizeOpenCodeModel = (value) => {
  const model = typeof value === 'string' ? value.trim() : '';
  return model === DEFAULT_OPENCODE_MODEL || OPENCODE_MODEL_PATTERN.test(model)
    ? model
    : DEFAULT_OPENCODE_MODEL;
};

/** @param {unknown} value */
const isOpenCodeModelAvailabilityError = (value) =>
  /\b(?:ProviderModelNotFoundError|model[_ ]not[_ ]found|unknown model|invalid model|model is not available|not available for|not supported|does not have access|do not have access|don't have access|access to model)\b/i.test(
    String(value ?? ''),
  ) ||
  /(?:\bmodel\b.{0,80}\b(?:403|404)\b|\b(?:403|404)\b.{0,80}\bmodel\b)/i.test(String(value ?? ''));

/** @param {string} template @param {unknown} model */
const renderOpenCodeCommand = (template, model) => {
  const placeholderCount = template.split(OPENCODE_COMMAND_MODEL_PLACEHOLDER).length - 1;
  if (placeholderCount !== 1) {
    throw new Error(
      `The OpenCode command template must contain exactly one ${OPENCODE_COMMAND_MODEL_PLACEHOLDER} placeholder.`,
    );
  }

  const normalizedModel = normalizeOpenCodeModel(model);
  const modelLine = normalizedModel === DEFAULT_OPENCODE_MODEL ? '' : `model: ${normalizedModel}`;
  return template.replace(OPENCODE_COMMAND_MODEL_PLACEHOLDER, modelLine);
};

/** @param {string} output @returns {string} */
const readOpenCodeText = (output) => {
  /** @type {Map<string, string>} */
  const parts = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const part = event?.type === 'text' ? event.part : null;
      if (part && typeof part.text === 'string') {
        parts.set(typeof part.id === 'string' ? part.id : String(parts.size), part.text);
      }
    } catch {
      // Keep compatibility with older OpenCode versions that may emit plain text.
    }
  }
  return parts.size > 0 ? [...parts.values()].join('\n') : output;
};

/**
 * @param {string} output
 * @param {unknown} schema
 * @returns {string}
 */
const normalizeOpenCodeOutput = (output, schema) =>
  normalizeStructuredOutput(readOpenCodeText(output), schema, 'OpenCode');

/**
 * @param {string} repoRoot
 * @param {string} prompt
 * @param {unknown} schema
 * @param {string} [_outputName]
 * @param {string} [timeoutMessage]
 * @param {{
 *   fallbackModel?: string;
 *   model?: string;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 *   onOutput?: (chunk: string) => void;
 *   onPartialText?: (delta: string) => void;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 * }} [options]
 */
const runOpenCode = async (
  repoRoot,
  prompt,
  schema,
  _outputName = 'opencode-output.json',
  timeoutMessage = 'OpenCode timed out.',
  options = {},
) => {
  const model = normalizeOpenCodeModel(options.model);
  const fallbackModel = normalizeOpenCodeModel(options.fallbackModel || FALLBACK_OPENCODE_MODEL);
  const timeoutMs = options.timeoutMs ?? OPENCODE_TIMEOUT_MS;
  const effectivePrompt = `${prompt}${buildSchemaReminder(schema)}`;

  /** @param {string} openCodeModel */
  const invokeOpenCode = (openCodeModel) =>
    /** @type {Promise<string>} */ (
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

        const opencodeCommand = getOpenCodeCommand();
        const opencodeArgs = [
          'run',
          '--format',
          'json',
          '--pure',
          '--agent',
          'build',
          '--dir',
          repoRoot,
          ...(openCodeModel === DEFAULT_OPENCODE_MODEL ? [] : ['--model', openCodeModel]),
        ];
        const child = spawn(opencodeCommand, opencodeArgs, {
          cwd: repoRoot,
          env: {
            ...process.env,
            OPENCODE_PERMISSION: JSON.stringify({ '*': 'deny' }),
          },
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

        // stdout carries only the final JSON payload, so it is not streamed;
        // stderr carries the CLI's live diagnostics.
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
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
          reject(getOpenCodeLaunchError(error));
        });
        child.on('close', (code, signal) => {
          stopAbortListener();
          if (finished) {
            return;
          }

          finished = true;
          clearTimeout(timer);

          if (code !== 0) {
            reject(
              new Error(
                oneLine(
                  stderr || stdout || stdinError?.message,
                  signal
                    ? `OpenCode was terminated by ${signal}.`
                    : `OpenCode exited with code ${code}.`,
                ),
              ),
            );
            return;
          }

          try {
            resolve(normalizeOpenCodeOutput(stdout, schema));
          } catch (error) {
            reject(error);
          }
        });

        child.stdin.end(effectivePrompt, () => {});
      })
    );

  try {
    return await invokeOpenCode(model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (model === fallbackModel || !isOpenCodeModelAvailabilityError(message)) {
      throw error;
    }

    const response = await invokeOpenCode(fallbackModel);
    await options.onModelFallback?.(fallbackModel, model);
    return response;
  }
};

module.exports = {
  DEFAULT_OPENCODE_MODEL,
  FALLBACK_OPENCODE_MODEL,
  OPENCODE_MODELS,
  OPENCODE_NOT_FOUND_CODE,
  OPENCODE_NOT_FOUND_MESSAGE,
  OPENCODE_TIMEOUT_MS,
  getOpenCodeCommand,
  isOpenCodeModelAvailabilityError,
  isOpenCodeNotFoundError,
  normalizeOpenCodeModel,
  normalizeOpenCodeOutput,
  readOpenCodeText,
  renderOpenCodeCommand,
  runOpenCode,
};
