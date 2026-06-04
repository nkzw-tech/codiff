// @ts-check

const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const { join } = require('node:path');
const {
  findExecutableOnPath,
  isExecutableFile,
  normalizeEnum,
  oneLine,
} = require('./agent-shared.cjs');

// Claude Code can be slower to first token than Codex, so allow a longer budget.
const CLAUDE_TIMEOUT_MS = 90_000;
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const FALLBACK_CLAUDE_MODEL = 'claude-haiku-4-5';
const CLAUDE_NOT_FOUND_CODE = 'CLAUDE_NOT_FOUND';
const CLAUDE_NOT_FOUND_MESSAGE =
  'Claude Code CLI was not found. Install Claude Code and verify `claude --version` works in Terminal. Codiff searches PATH, ~/.local/bin/claude, /opt/homebrew/bin/claude, and /usr/local/bin/claude. If Claude Code is installed somewhere else, launch Codiff with `CODIFF_CLAUDE_PATH=/absolute/path/to/claude codiff -w`.';
const CLAUDE_NOT_LOGGED_IN_MESSAGE =
  'Claude Code is not logged in. Run `claude` in Terminal and complete `/login`, then try again.';

/**
 * @typedef {{
 *   fallbackModel?: string;
 *   model?: string;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 * }} ClaudeOptions
 */
/**
 * @typedef {{
 *   id: string;
 *   label: string;
 * }} ClaudeModel
 */
/** @type {ReadonlyArray<ClaudeModel>} */
const CLAUDE_MODELS = Object.freeze([
  {
    id: 'claude-opus-4-8',
    label: 'Best: Claude Opus 4.8',
  },
  {
    id: DEFAULT_CLAUDE_MODEL,
    label: 'Balanced: Claude Sonnet 4.6',
  },
  {
    id: FALLBACK_CLAUDE_MODEL,
    label: 'Fast: Claude Haiku 4.5',
  },
]);
const CLAUDE_MODEL_IDS = new Set(CLAUDE_MODELS.map((model) => model.id));

/** @param {string} [detail] */
const createClaudeNotFoundError = (detail) =>
  Object.assign(
    new Error(detail ? `${CLAUDE_NOT_FOUND_MESSAGE} ${detail}` : CLAUDE_NOT_FOUND_MESSAGE),
    {
      code: CLAUDE_NOT_FOUND_CODE,
    },
  );

const getClaudeCommand = () => {
  const claudePath = process.env.CODIFF_CLAUDE_PATH?.trim();
  if (claudePath) {
    if (isExecutableFile(claudePath)) {
      return claudePath;
    }

    throw createClaudeNotFoundError(
      `CODIFF_CLAUDE_PATH is set to ${JSON.stringify(claudePath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('claude');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createClaudeNotFoundError();
};

/** @param {unknown} error */
const isClaudeNotFoundError = (error) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === CLAUDE_NOT_FOUND_CODE || error.code === 'ENOENT'),
  );

/** @param {string} value */
const isClaudeNotLoggedInError = (value) =>
  /\b(?:not logged in|please run \/login|run \/login|invalid api key|authentication_error|oauth)\b/i.test(
    value,
  );

/** @param {unknown} value @returns {string} */
const normalizeClaudeModel = (value) =>
  normalizeEnum(value, CLAUDE_MODEL_IDS, DEFAULT_CLAUDE_MODEL);

/** @param {string} value */
const isClaudeModelAvailabilityError = (value) =>
  /\b(?:model_not_found|unknown model|invalid model|model is not available|not available for|not supported|does not have access|do not have access|don't have access|access to model|403|404)\b/i.test(
    value,
  );

/**
 * @param {unknown} error
 */
const getClaudeLaunchError = (error) => {
  if (isClaudeNotFoundError(error)) {
    return createClaudeNotFoundError();
  }

  return error instanceof Error ? error : new Error(String(error ?? ''));
};

/**
 * Run Claude Code headless as a pure, read-only structured-output call.
 *
 * Mirrors the shape of {@link runCodex}: prompt is sent on stdin, output is a
 * JSON string validated against the provided schema. Tools are fully disabled
 * so Claude answers only from the prompt text, and session persistence is off
 * so the call leaves no transcript behind.
 *
 * @param {string} repoRoot
 * @param {string} prompt
 * @param {unknown} schema
 * @param {string} [_outputName]
 * @param {string} [timeoutMessage]
 * @param {ClaudeOptions} [options]
 */
const runClaude = async (
  repoRoot,
  prompt,
  schema,
  _outputName = 'claude-output.json',
  timeoutMessage = 'Claude Code timed out.',
  options = {},
) => {
  const model = normalizeClaudeModel(options.model);
  const fallbackModel = normalizeClaudeModel(options.fallbackModel || FALLBACK_CLAUDE_MODEL);

  /** @param {string} claudeModel @returns {Promise<string>} */
  const invokeClaude = async (claudeModel) =>
    /** @type {Promise<string>} */ (
      new Promise((resolve, reject) => {
        let stderr = '';
        /** @type {Error | null} */
        let stdinError = null;
        let stdout = '';
        let finished = false;

        const claudeCommand = getClaudeCommand();
        const claudeArgs = [
          '-p',
          '--output-format',
          'json',
          '--json-schema',
          JSON.stringify(schema),
          '--model',
          claudeModel,
          '--add-dir',
          repoRoot,
          '--permission-mode',
          'dontAsk',
          '--no-session-persistence',
          '--tools',
          '',
        ];
        const child = spawn(claudeCommand, claudeArgs, {
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
        }, CLAUDE_TIMEOUT_MS);

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
          reject(getClaudeLaunchError(error));
        });
        child.on('close', (code, signal) => {
          if (finished) {
            return;
          }

          finished = true;
          clearTimeout(timer);

          if (code !== 0) {
            const message = oneLine(
              stderr || stdout || stdinError?.message,
              signal
                ? `Claude Code was terminated by ${signal}.`
                : `Claude Code exited with code ${code}.`,
            );
            reject(new Error(message));
            return;
          }

          /** @type {any} */
          let envelope;
          try {
            envelope = JSON.parse(stdout);
          } catch {
            reject(new Error(oneLine(stdout, 'Claude Code did not return JSON.')));
            return;
          }

          const resultText = typeof envelope?.result === 'string' ? envelope.result : '';
          if (envelope?.is_error) {
            reject(
              new Error(
                isClaudeNotLoggedInError(resultText)
                  ? CLAUDE_NOT_LOGGED_IN_MESSAGE
                  : oneLine(resultText, 'Claude Code reported an error.'),
              ),
            );
            return;
          }

          if (envelope?.structured_output && typeof envelope.structured_output === 'object') {
            resolve(JSON.stringify(envelope.structured_output));
            return;
          }

          resolve(resultText);
        });

        child.stdin.end(prompt, () => {});
      })
    );

  try {
    return await invokeClaude(model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (model === fallbackModel || !isClaudeModelAvailabilityError(message)) {
      throw error;
    }

    const response = await invokeClaude(fallbackModel);
    await options.onModelFallback?.(fallbackModel, model);
    return response;
  }
};

module.exports = {
  CLAUDE_MODELS,
  CLAUDE_NOT_FOUND_CODE,
  CLAUDE_NOT_FOUND_MESSAGE,
  DEFAULT_CLAUDE_MODEL,
  FALLBACK_CLAUDE_MODEL,
  getClaudeCommand,
  isClaudeModelAvailabilityError,
  isClaudeNotFoundError,
  isClaudeNotLoggedInError,
  normalizeClaudeModel,
  runClaude,
};
