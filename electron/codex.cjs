// @ts-check

const { promises: fs } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join } = require('node:path');
const { resolveAgentCommandTransport } = require('./agent-command.cjs');
const { getCommandEnvironment } = require('./login-shell-environment.cjs');
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
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';
const FALLBACK_OPENAI_MODEL = 'gpt-5.5';
const LEGACY_OPENAI_MODEL = 'gpt-5.3-codex-spark';
const CODEX_REASONING_EFFORT = 'low';
const CODEX_MACOS_BLOCKED_MESSAGE =
  'macOS blocked the local Codex CLI. Update Codex CLI from the official OpenAI release, then run `codex --version` and try again.';
const CODEX_NOT_FOUND_CODE = 'CODEX_NOT_FOUND';
const CODEX_APP_SERVER_UNAVAILABLE_CODE = 'CODEX_APP_SERVER_UNAVAILABLE';
const CODEX_NOT_FOUND_MESSAGE =
  'Codex CLI was not found. Install Codex and verify `codex --version` works in Terminal. On macOS, Codiff also checks for the CLI bundled with Codex.app. If Codex is installed somewhere else, launch Codiff with `CODIFF_CODEX_PATH=/absolute/path/to/codex codiff -w`.';
/**
 * @typedef {{
 *   fallbackModel?: string;
 *   commandTransport?: import('./agent-command.cjs').AgentCommandTransport;
 *   model?: string;
 *   onMetrics?: (metrics: {
 *     transport: 'app-server' | 'exec';
 *     usage?: {
 *       cachedInputTokens: number;
 *       inputTokens: number;
 *       outputTokens: number;
 *       reasoningOutputTokens: number;
 *       totalTokens: number;
 *     };
 *   }) => void;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 *   onProgress?: (phase: import('../core/types.ts').WalkthroughProgressPhase) => void;
 *   reasoningEffort?: 'low' | 'medium' | 'high';
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
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
    label: 'Default: GPT-5.6 Terra',
  },
  {
    id: 'gpt-5.6-sol',
    label: 'Strong: GPT-5.6 Sol',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'Fast: GPT-5.6 Luna',
  },
  {
    id: FALLBACK_OPENAI_MODEL,
    label: 'Compatibility: GPT-5.5',
  },
  {
    id: LEGACY_OPENAI_MODEL,
    label: 'Preview: GPT-5.3 Codex Spark',
  },
]);
const OPENAI_MODEL_IDS = new Set(OPENAI_MODELS.map((model) => model.id));
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const OPENAI_MODEL_REASONING_EFFORTS = new Map([
  ['gpt-5.6-sol', 'medium'],
  ['gpt-5.6-luna', 'medium'],
]);

/** @param {string} [detail] */
const createCodexNotFoundError = (detail) =>
  Object.assign(
    new Error(detail ? `${CODEX_NOT_FOUND_MESSAGE} ${detail}` : CODEX_NOT_FOUND_MESSAGE),
    {
      code: CODEX_NOT_FOUND_CODE,
    },
  );

/**
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 */
const getCodexInstallPaths = (platform = process.platform, home = homedir()) => [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  ...(platform === 'darwin'
    ? [
        '/Applications/Codex.app/Contents/Resources/codex',
        join(home, 'Applications/Codex.app/Contents/Resources/codex'),
      ]
    : []),
];

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

  for (const path of getCodexInstallPaths()) {
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

/** @param {unknown} model @param {unknown} [reasoningEffort] */
const getOpenAIModelReasoningEffort = (model, reasoningEffort) =>
  normalizeEnum(
    reasoningEffort,
    CODEX_REASONING_EFFORTS,
    OPENAI_MODEL_REASONING_EFFORTS.get(normalizeOpenAIModel(model)) || CODEX_REASONING_EFFORT,
  );

/** @param {unknown} model @param {unknown} [fallbackModel] */
const getOpenAIModelFallbacks = (model, fallbackModel = FALLBACK_OPENAI_MODEL) => {
  const normalizedModel = normalizeOpenAIModel(model);
  const candidates = [
    ...(normalizedModel === 'gpt-5.6-sol' || normalizedModel === 'gpt-5.6-luna'
      ? [DEFAULT_OPENAI_MODEL]
      : []),
    normalizeOpenAIModel(fallbackModel),
  ];
  return [...new Set(candidates)].filter((candidate) => candidate !== normalizedModel);
};

/** @param {string} value */
const isOpenAIModelAvailabilityError = (value) =>
  /\b(?:model_not_found|unknown model|invalid model|model is not available|not available for|not supported|does not have access|do not have access|don't have access|access to model|403|404)\b/i.test(
    value,
  );

/** @param {any} usage */
const normalizeCodexUsage = (usage) => {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens) || 0;
  const cachedInputTokens = Number(usage.cached_input_tokens ?? usage.cachedInputTokens) || 0;
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens) || 0;
  const reasoningOutputTokens =
    Number(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens) || 0;
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens;

  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
};

/**
 * Consume `codex exec --json` JSONL without exposing model output. This is the
 * compatibility parser for older CLIs without app-server support.
 *
 * @param {CodexOptions['onProgress']} onProgress
 */
const createCodexEventParser = (onProgress) => {
  let lineBuffer = '';
  let lastMessage = '';
  let usage;

  /** @param {unknown} input */
  const handleEvent = (input) => {
    const event = /** @type {any} */ (input);
    if (!event || typeof event !== 'object') {
      return;
    }

    if (event.type === 'turn.completed') {
      usage = normalizeCodexUsage(event.usage);
    }

    if (event.type === 'thread.started') {
      onProgress?.('agent-generation');
      return;
    }

    const itemType = event.item?.type;
    if (
      (event.type === 'item.started' && itemType !== 'agent_message') ||
      (event.type === 'item.completed' && itemType === 'reasoning')
    ) {
      onProgress?.('agent-generation');
      return;
    }

    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      itemType === 'agent_message'
    ) {
      onProgress?.('response-received');
      const text = event.item?.text;
      if (typeof text === 'string' && text.trim()) {
        lastMessage = text;
      }
    }
  };

  /** @param {string} text */
  const push = (text) => {
    lineBuffer += text;
    let newlineIndex = lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // Codex diagnostics are retained by the caller for error reporting.
        }
      }
      newlineIndex = lineBuffer.indexOf('\n');
    }
  };

  const flush = () => {
    const rest = lineBuffer.trim();
    lineBuffer = '';
    if (rest) {
      try {
        handleEvent(JSON.parse(rest));
      } catch {}
    }
    return { lastMessage, usage };
  };

  return { flush, push };
};

/** @param {unknown} error */
const isCodexAppServerUnavailableError = (error) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === CODEX_APP_SERVER_UNAVAILABLE_CODE,
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
  const fallbackModels = getOpenAIModelFallbacks(model, options.fallbackModel);
  const timeoutMs = options.timeoutMs ?? CODEX_TIMEOUT_MS;

  /** @param {string} codexModel @returns {Promise<string>} */
  const invokeCodexExec = async (codexModel) => {
    const reasoningEffort = getOpenAIModelReasoningEffort(codexModel, options.reasoningEffort);
    const directory = await fs.mkdtemp(join(tmpdir(), 'codiff-codex-'));
    const outputPath = join(directory, outputName);
    const schemaPath = join(directory, 'schema.json');
    await fs.writeFile(schemaPath, JSON.stringify(schema), 'utf8');
    const environment = await getCommandEnvironment();

    return await /** @type {Promise<string>} */ (
      new Promise((resolve, reject) => {
        let stderr = '';
        /** @type {Error | null} */
        let stdinError = null;
        let stdout = '';
        let finished = false;

        const commandTransport = resolveAgentCommandTransport(
          options.commandTransport,
          getCodexCommand,
        );
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
          '--json',
          '--output-schema',
          schemaPath,
          '--output-last-message',
          outputPath,
          '-',
        ];
        const child = commandTransport.spawn(commandTransport.command, codexArgs, {
          env: environment,
          signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const eventParser = createCodexEventParser(options.onProgress);

        const timer = setTimeout(() => {
          if (!finished) {
            finished = true;
            child.kill('SIGTERM');
            reject(new Error(timeoutMessage));
          }
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          stdout += text;
          eventParser.push(text);
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

          const { lastMessage: streamedMessage, usage } = eventParser.flush();
          options.onMetrics?.({ transport: 'exec', usage });
          try {
            const message = await fs.readFile(outputPath, 'utf8');
            resolve(message);
          } catch {
            resolve(streamedMessage || stdout);
          }
        });

        child.stdin.end(prompt, () => {});
      })
    ).finally(() => fs.rm(directory, { force: true, recursive: true }).catch(() => {}));
  };

  /**
   * Use Codex app-server for walkthroughs because it exposes genuine reasoning
   * and agent-message deltas. The deltas are accumulated privately into the
   * same final structured response returned by `codex exec`.
   *
   * @param {string} codexModel
   * @returns {Promise<string>}
   */
  const invokeCodexAppServer = async (codexModel) => {
    const reasoningEffort = getOpenAIModelReasoningEffort(codexModel, options.reasoningEffort);
    const environment = await getCommandEnvironment();
    return new Promise((resolve, reject) => {
      const commandTransport = resolveAgentCommandTransport(
        options.commandTransport,
        getCodexCommand,
      );
      const child = commandTransport.spawn(
        commandTransport.command,
        ['app-server', '--stdio', '-c', `model_reasoning_effort="${reasoningEffort}"`],
        {
          cwd: repoRoot,
          env: environment,
          signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let finished = false;
      let lastError = '';
      let lineBuffer = '';
      let nextRequestId = 1;
      let stderr = '';
      let streamedMessage = '';
      let usage;
      /** @type {Map<number, {reject: (error: Error) => void; resolve: (result: any) => void}>} */
      const pendingRequests = new Map();

      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          child.kill('SIGTERM');
          reject(new Error(timeoutMessage));
        }
      }, timeoutMs);

      /** @param {unknown} message */
      const send = (message) => {
        if (!finished) {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        }
      };

      /** @param {string} method @param {unknown} params */
      const request = (method, params) => {
        const id = nextRequestId;
        nextRequestId += 1;
        return new Promise((resolveRequest, rejectRequest) => {
          pendingRequests.set(id, {
            reject: rejectRequest,
            resolve: resolveRequest,
          });
          send({ id, method, params });
        });
      };

      /** @param {Error} error */
      const fail = (error) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
        reject(error);
      };

      /** @param {string} message */
      const succeed = (message) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve(message);
      };

      /** @param {any} message */
      const handleMessage = (message) => {
        if (message?.id != null && pendingRequests.has(message.id)) {
          const pending = pendingRequests.get(message.id);
          pendingRequests.delete(message.id);
          if (message.error) {
            const detail = oneLine(
              message.error?.message || JSON.stringify(message.error),
              'Codex app server request failed.',
            );
            pending?.reject(new Error(detail));
          } else {
            pending?.resolve(message.result);
          }
          return;
        }

        // App-server can issue approval/tool requests to the client. Walkthrough
        // generation is deliberately non-interactive and read-only.
        if (message?.id != null && typeof message.method === 'string') {
          send({
            error: {
              code: -32601,
              message: 'Codiff walkthrough generation does not handle interactive requests.',
            },
            id: message.id,
          });
          return;
        }

        const method = message?.method;
        const params = message?.params;
        if (method === 'thread/tokenUsage/updated') {
          usage = normalizeCodexUsage(params?.tokenUsage?.total);
          return;
        }
        if (
          method === 'thread/started' ||
          method === 'turn/started' ||
          (method === 'item/started' && params?.item?.type === 'reasoning') ||
          method === 'item/reasoning/textDelta' ||
          method === 'item/reasoning/summaryTextDelta'
        ) {
          options.onProgress?.('agent-generation');
          return;
        }
        if (method === 'item/agentMessage/delta') {
          options.onProgress?.('response-received');
          if (typeof params?.delta === 'string') {
            streamedMessage += params.delta;
          }
          return;
        }
        if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
          options.onProgress?.('response-received');
          if (!streamedMessage && typeof params.item.text === 'string') {
            streamedMessage = params.item.text;
          }
          return;
        }
        if (method === 'error') {
          const detail = oneLine(params?.error?.message);
          if (detail) {
            lastError = detail;
          }
          return;
        }
        if (method !== 'turn/completed') {
          return;
        }

        const turn = params?.turn;
        if (turn?.status !== 'completed') {
          fail(
            new Error(
              oneLine(
                turn?.error?.message || lastError,
                'Codex could not complete the walkthrough.',
              ),
            ),
          );
          return;
        }
        if (!streamedMessage) {
          const finalMessage = Array.isArray(turn.items)
            ? turn.items.findLast((item) => item?.type === 'agentMessage')?.text
            : '';
          if (typeof finalMessage === 'string') {
            streamedMessage = finalMessage;
          }
        }
        if (!streamedMessage.trim()) {
          fail(new Error('Codex did not produce a final answer.'));
          return;
        }
        options.onMetrics?.({
          transport: 'app-server',
          usage: usage ?? normalizeCodexUsage(turn?.usage ?? params?.usage),
        });
        succeed(streamedMessage);
      };

      child.stdout.on('data', (chunk) => {
        lineBuffer += chunk.toString();
        let newlineIndex = lineBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = lineBuffer.slice(0, newlineIndex).trim();
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          if (line) {
            try {
              handleMessage(JSON.parse(line));
            } catch {
              // App-server stdout is JSONL; malformed lines are retained via
              // stderr/close diagnostics instead of reaching the renderer.
            }
          }
          newlineIndex = lineBuffer.indexOf('\n');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.stdin.on('error', (error) => {
        if (!finished) {
          fail(error);
        }
      });
      child.on('error', (error) => {
        fail(getCodexLaunchError(error));
      });
      child.on('close', (code, signal) => {
        if (finished) {
          return;
        }
        const message = oneLine(
          stderr || lastError,
          signal
            ? `Codex app server was terminated by ${signal}.`
            : `Codex app server exited with code ${code}.`,
        );
        const error = new Error(message);
        if (
          /\b(?:app-server|stdio)\b.*\b(?:unrecognized|unknown|unsupported)\b/i.test(message) ||
          /\b(?:unrecognized|unknown|unsupported)\b.*\b(?:app-server|stdio)\b/i.test(message)
        ) {
          Object.assign(error, { code: CODEX_APP_SERVER_UNAVAILABLE_CODE });
        }
        fail(getCodexLaunchError(error));
      });

      void (async () => {
        await request('initialize', {
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
          clientInfo: {
            name: 'codiff',
            title: 'Codiff',
            version: '1',
          },
        });
        send({ method: 'initialized' });
        const thread = await request('thread/start', {
          approvalPolicy: 'never',
          config: {
            model_reasoning_effort: reasoningEffort,
          },
          cwd: repoRoot,
          ephemeral: true,
          model: codexModel,
          sandbox: 'read-only',
          serviceName: 'codiff',
        });
        const threadId = thread?.thread?.id;
        if (typeof threadId !== 'string' || !threadId) {
          throw new Error('Codex app server did not create a thread.');
        }
        await request('turn/start', {
          approvalPolicy: 'never',
          cwd: repoRoot,
          effort: reasoningEffort,
          input: [
            {
              text: prompt,
              text_elements: [],
              type: 'text',
            },
          ],
          model: codexModel,
          outputSchema: schema,
          sandboxPolicy: {
            networkAccess: false,
            type: 'readOnly',
          },
          threadId,
        });
      })().catch((error) => {
        fail(getCodexLaunchError(error));
      });
    });
  };

  /** @param {string} codexModel */
  const invokeCodex = async (codexModel) => {
    if (!options.onProgress) {
      return invokeCodexExec(codexModel);
    }
    try {
      return await invokeCodexAppServer(codexModel);
    } catch (error) {
      if (!isCodexAppServerUnavailableError(error)) {
        throw error;
      }
      return invokeCodexExec(codexModel);
    }
  };

  const candidates = [model, ...fallbackModels];
  for (const [index, candidate] of candidates.entries()) {
    try {
      const response = await invokeCodex(candidate);
      if (candidate !== model) {
        await options.onModelFallback?.(candidate, model);
      }
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (index === candidates.length - 1 || !isOpenAIModelAvailabilityError(message)) {
        throw error;
      }
    }
  }

  throw new Error('Codex did not attempt a model.');
};

module.exports = {
  CODEX_NOT_FOUND_CODE,
  CODEX_TIMEOUT_MS,
  cleanText,
  DEFAULT_OPENAI_MODEL,
  FALLBACK_OPENAI_MODEL,
  getCodexCommand,
  getOpenAIModelFallbacks,
  isCodexNotFoundError,
  normalizeOpenAIModel,
  OPENAI_MODELS,
  runCodex,
  truncate,
};
