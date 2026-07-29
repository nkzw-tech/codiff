// @ts-check

const { createServer } = require('node:net');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { resolveAgentCommandTransport } = require('./agent-command.cjs');
const { getCommandEnvironment } = require('./login-shell-environment.cjs');
const {
  buildSchemaReminder,
  findExecutableOnPath,
  isExecutableFile,
  normalizeStructuredOutput,
  oneLine,
} = require('./agent-shared.cjs');

const OPENCODE_TIMEOUT_MS = 300_000;
const DEFAULT_OPENCODE_MODEL = 'opencode-default';
const FALLBACK_OPENCODE_MODEL = DEFAULT_OPENCODE_MODEL;
const OPENCODE_COMMAND_MODEL_PLACEHOLDER = '{{CODIFF_OPENCODE_MODEL}}';
const OPENCODE_NOT_FOUND_CODE = 'OPENCODE_NOT_FOUND';
const OPENCODE_STREAMING_UNAVAILABLE_CODE = 'OPENCODE_STREAMING_UNAVAILABLE';
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

/** @param {unknown} error */
const isOpenCodeStreamingUnavailableError = (error) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === OPENCODE_STREAMING_UNAVAILABLE_CODE,
  );

/** @param {unknown} error */
const createOpenCodeStreamingUnavailableError = (error) =>
  Object.assign(getOpenCodeLaunchError(error), { code: OPENCODE_STREAMING_UNAVAILABLE_CODE });

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

const reserveOpenCodePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port == null) {
          reject(new Error('OpenCode could not reserve a local server port.'));
        } else {
          resolve(port);
        }
      });
    });
  });

/** @param {string} output */
const readOpenCodeServerText = (output) => {
  try {
    const response = JSON.parse(output);
    if (response?.info?.error) {
      throw new Error(
        oneLine(
          response.info.error?.data?.message || response.info.error?.name,
          'OpenCode reported an error.',
        ),
      );
    }
    const parts = Array.isArray(response?.parts) ? response.parts : [];
    const text = parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
    return text;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return output;
    }
    throw error;
  }
};

/**
 * @param {unknown} input
 * @param {string} sessionId
 * @param {(phase: import('../core/types.ts').WalkthroughProgressPhase) => void} onProgress
 * @param {{assistantMessageIds: Set<string>; textParts: Map<string, string>}} state
 */
const handleOpenCodeProgressEvent = (input, sessionId, onProgress, state) => {
  const event = /** @type {any} */ (input)?.payload || input;
  const properties = event?.properties;
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.type !== 'string' ||
    properties?.sessionID !== sessionId
  ) {
    return;
  }

  if (event.type === 'message.updated' && properties.info?.role === 'assistant') {
    state.assistantMessageIds.add(properties.info.id);
    return;
  }

  const messageId =
    properties.assistantMessageID || properties.messageID || properties.part?.messageID;
  const isAssistantMessage =
    event.type.startsWith('session.next.') || state.assistantMessageIds.has(messageId);
  if (!isAssistantMessage) {
    return;
  }

  if (
    event.type.startsWith('session.next.reasoning.') ||
    (event.type === 'message.part.updated' &&
      ['reasoning', 'step-start'].includes(properties.part?.type))
  ) {
    onProgress('agent-generation');
    return;
  }

  if (
    event.type === 'session.next.text.started' ||
    event.type === 'session.next.text.delta' ||
    (event.type === 'message.part.updated' && properties.part?.type === 'text')
  ) {
    onProgress('response-received');
  }

  if (
    event.type === 'message.part.delta' &&
    properties.field === 'text' &&
    typeof properties.delta === 'string'
  ) {
    const partId = String(properties.partID || state.textParts.size);
    state.textParts.set(partId, `${state.textParts.get(partId) || ''}${properties.delta}`);
    onProgress('response-received');
  }
};

/**
 * @param {Response} response
 * @param {string} sessionId
 * @param {(phase: import('../core/types.ts').WalkthroughProgressPhase) => void} onProgress
 * @param {{assistantMessageIds: Set<string>; textParts: Map<string, string>}} state
 */
const consumeOpenCodeEventStream = async (response, sessionId, onProgress, state) => {
  if (!response.body) {
    throw createOpenCodeStreamingUnavailableError(
      new Error('OpenCode did not provide an event stream.'),
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let frameEnd = buffer.search(/\r?\n\r?\n/);
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd);
      const separator = buffer.slice(frameEnd).match(/^\r?\n\r?\n/)?.[0] || '\n\n';
      buffer = buffer.slice(frameEnd + separator.length);
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (!data) {
          continue;
        }
        try {
          handleOpenCodeProgressEvent(JSON.parse(data), sessionId, onProgress, state);
        } catch {
          // Ignore malformed diagnostics without exposing them to the renderer.
        }
      }
      frameEnd = buffer.search(/\r?\n\r?\n/);
    }
  }
};

/** @param {string} model */
const getOpenCodeServerModel = (model) => {
  if (model === DEFAULT_OPENCODE_MODEL) {
    return undefined;
  }
  const [providerID, ...modelParts] = model.split('/');
  return { modelID: modelParts.join('/'), providerID };
};

/**
 * @param {string} repoRoot
 * @param {string} prompt
 * @param {unknown} schema
 * @param {string} [_outputName]
 * @param {string} [timeoutMessage]
 * @param {{
 *   commandTransport?: import('./agent-command.cjs').AgentCommandTransport;
 *   fallbackModel?: string;
 *   model?: string;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 *   onPartialText?: (delta: string) => void;
 *   onProgress?: (phase: import('../core/types.ts').WalkthroughProgressPhase) => void;
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
  const invokeOpenCodeCli = async (openCodeModel) => {
    const environment = await getCommandEnvironment();
    return /** @type {Promise<string>} */ (
      new Promise((resolve, reject) => {
        let stderr = '';
        /** @type {Error | null} */
        let stdinError = null;
        let stdout = '';
        let finished = false;

        const commandTransport = resolveAgentCommandTransport(
          options.commandTransport,
          getOpenCodeCommand,
        );
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
        const child = commandTransport.spawn(commandTransport.command, opencodeArgs, {
          cwd: repoRoot,
          env: {
            ...environment,
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
          reject(getOpenCodeLaunchError(error));
        });
        child.on('close', (code, signal) => {
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
  };

  /** @param {string} openCodeModel */
  const invokeOpenCodeServer = async (openCodeModel) => {
    const commandTransport = resolveAgentCommandTransport(
      options.commandTransport,
      getOpenCodeCommand,
    );
    const port = await reserveOpenCodePort();
    const environment = await getCommandEnvironment();
    const child = commandTransport.spawn(
      commandTransport.command,
      ['serve', '--pure', '--hostname=127.0.0.1', `--port=${port}`],
      {
        cwd: repoRoot,
        env: {
          ...environment,
          OPENCODE_PERMISSION: JSON.stringify({ '*': 'deny' }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const abortController = new AbortController();
    let baseUrl = '';
    let sessionId = '';
    let startupOutput = '';
    let timeout;

    try {
      baseUrl = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) {
            return;
          }
          settled = true;
          callback(value);
        };
        timeout = setTimeout(
          () => {
            finish(
              reject,
              createOpenCodeStreamingUnavailableError(
                new Error('Timed out waiting for the OpenCode event server to start.'),
              ),
            );
          },
          Math.min(timeoutMs, 5_000),
        );
        child.stdout.on('data', (chunk) => {
          startupOutput += chunk.toString();
          for (const line of startupOutput.split(/\r?\n/)) {
            const match = line.match(/opencode server listening.*\bon\s+(https?:\/\/\S+)/);
            if (match) {
              clearTimeout(timeout);
              finish(resolve, match[1]);
              return;
            }
          }
        });
        child.stderr.on('data', (chunk) => {
          startupOutput += chunk.toString();
        });
        child.on('error', (error) => {
          clearTimeout(timeout);
          finish(reject, createOpenCodeStreamingUnavailableError(error));
        });
        child.on('close', (code, signal) => {
          clearTimeout(timeout);
          finish(
            reject,
            createOpenCodeStreamingUnavailableError(
              new Error(
                oneLine(
                  startupOutput,
                  signal
                    ? `OpenCode event server was terminated by ${signal}.`
                    : `OpenCode event server exited with code ${code}.`,
                ),
              ),
            ),
          );
        });
      });

      timeout = setTimeout(() => abortController.abort(new Error(timeoutMessage)), timeoutMs);
      const directory = new URLSearchParams({ directory: repoRoot });
      const request = async (path, init) => {
        try {
          return await fetch(`${baseUrl}${path}?${directory}`, {
            ...init,
            signal: abortController.signal,
          });
        } catch (error) {
          if (abortController.signal.aborted) {
            throw abortController.signal.reason;
          }
          throw createOpenCodeStreamingUnavailableError(error);
        }
      };
      const sessionResponse = await request('/session', {
        body: JSON.stringify({
          agent: 'build',
          permission: [{ action: 'deny', pattern: '*', permission: '*' }],
          title: 'Codiff walkthrough',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!sessionResponse.ok) {
        throw createOpenCodeStreamingUnavailableError(
          new Error(
            oneLine(
              await sessionResponse.text(),
              `OpenCode session creation failed with status ${sessionResponse.status}.`,
            ),
          ),
        );
      }
      const session = await sessionResponse.json();
      sessionId = typeof session?.id === 'string' ? session.id : '';
      if (!sessionId) {
        throw createOpenCodeStreamingUnavailableError(
          new Error('OpenCode session creation did not return a session ID.'),
        );
      }

      const eventResponse = await request('/event', {
        headers: { accept: 'text/event-stream' },
      });
      if (
        !eventResponse.ok ||
        !eventResponse.headers.get('content-type')?.includes('text/event-stream')
      ) {
        throw createOpenCodeStreamingUnavailableError(
          new Error(`OpenCode event streaming is unavailable (${eventResponse.status}).`),
        );
      }
      const progressState = { assistantMessageIds: new Set(), textParts: new Map() };
      const eventStream = consumeOpenCodeEventStream(
        eventResponse,
        sessionId,
        options.onProgress,
        progressState,
      ).catch(() => {});

      const model = getOpenCodeServerModel(openCodeModel);
      const promptResponse = await request(`/session/${encodeURIComponent(sessionId)}/message`, {
        body: JSON.stringify({
          agent: 'build',
          ...(model ? { model } : {}),
          parts: [{ text: effectivePrompt, type: 'text' }],
          tools: {},
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const responseText = await promptResponse.text();
      if (!promptResponse.ok) {
        if ([404, 405].includes(promptResponse.status)) {
          throw createOpenCodeStreamingUnavailableError(
            new Error(`OpenCode streaming prompt is unavailable (${promptResponse.status}).`),
          );
        }
        throw new Error(
          oneLine(responseText, `OpenCode request failed with status ${promptResponse.status}.`),
        );
      }

      const output = readOpenCodeServerText(responseText);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const streamedText = [...progressState.textParts.values()].join('\n');
      abortController.abort();
      await eventStream;
      return normalizeStructuredOutput(output || streamedText, schema, 'OpenCode');
    } finally {
      clearTimeout(timeout);
      if (baseUrl && sessionId) {
        await fetch(
          `${baseUrl}/session/${encodeURIComponent(sessionId)}?${new URLSearchParams({
            directory: repoRoot,
          })}`,
          { method: 'DELETE', signal: AbortSignal.timeout(500) },
        ).catch(() => {});
      }
      abortController.abort();
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }
  };

  /** @param {string} openCodeModel */
  const invokeOpenCode = async (openCodeModel) => {
    if (!options.onProgress) {
      return invokeOpenCodeCli(openCodeModel);
    }
    try {
      return await invokeOpenCodeServer(openCodeModel);
    } catch (error) {
      if (!isOpenCodeStreamingUnavailableError(error)) {
        throw error;
      }
      return invokeOpenCodeCli(openCodeModel);
    }
  };

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
  OPENCODE_TIMEOUT_MS,
  getOpenCodeCommand,
  isOpenCodeNotFoundError,
  normalizeOpenCodeModel,
  renderOpenCodeCommand,
  runOpenCode,
};
