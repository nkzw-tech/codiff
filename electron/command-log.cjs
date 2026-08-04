// @ts-check

const { appendFile, chmod, mkdir, writeFile } = require('node:fs/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
const { dirname, join } = require('node:path');
const { performance } = require('node:perf_hooks');

/** @type {string | null} */
let commandLogPath = null;
let nextTimingId = 0;
let pendingWrites = Promise.resolve();
/** @type {AsyncLocalStorage<{actionId: number, signal: AbortSignal}>} */
const actionContext = new AsyncLocalStorage();

const secretFlag = /(?:authorization|password|private[-_]?token|secret|token)/i;

/** @param {unknown} error */
const processErrorOutcome = (error) => {
  if (!error || typeof error !== 'object') {
    return { exitCode: null, signal: null };
  }
  const result = /** @type {{code?: unknown, exitCode?: unknown, signal?: unknown}} */ (error);
  return {
    exitCode:
      typeof result.exitCode === 'number'
        ? result.exitCode
        : typeof result.code === 'number'
          ? result.code
          : null,
    signal: typeof result.signal === 'string' ? result.signal : null,
  };
};

/** @param {string} value */
const sanitizeValue = (value) => {
  if (/^https?:/i.test(value) || (value.startsWith('/') && value.includes('?'))) {
    try {
      const absolute = /^https?:/i.test(value);
      const url = new URL(value, 'https://codiff.invalid');
      if (url.username) url.username = '[REDACTED]';
      if (url.password) url.password = '[REDACTED]';
      for (const key of url.searchParams.keys()) {
        if (secretFlag.test(key)) {
          url.searchParams.set(key, '[REDACTED]');
        }
      }
      return absolute ? url.toString() : `${url.pathname}${url.search}`;
    } catch {
      return value;
    }
  }
  const header = /^([^:]+):\s*(.*)$/.exec(value);
  if (header && secretFlag.test(header[1])) {
    return `${header[1]}: [REDACTED]`;
  }
  const equals = value.indexOf('=');
  return equals > 0 && secretFlag.test(value.slice(0, equals))
    ? `${value.slice(0, equals + 1)}[REDACTED]`
    : value;
};

/** @param {ReadonlyArray<string>} args */
const sanitizeArgs = (args) => {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return '[REDACTED]';
    }
    const lower = argument.toLowerCase();
    if (lower === '--header' || lower === '-h') {
      redactNext = true;
      return argument;
    }
    if (lower.startsWith('--header=')) {
      return `${argument.slice(0, argument.indexOf('=') + 1)}${sanitizeValue(
        argument.slice(argument.indexOf('=') + 1),
      )}`;
    }
    if (lower.startsWith('-h') && argument.length > 2) {
      return `${argument.slice(0, 2)}${sanitizeValue(argument.slice(2))}`;
    }
    if (secretFlag.test(argument.split('=')[0])) {
      return argument.includes('=') ? sanitizeValue(argument) : argument;
    }
    return sanitizeValue(argument);
  });
};

/** @param {unknown} value @param {string} [key] */
const sanitizeDetailValue = (value, key = '') => {
  if (secretFlag.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return sanitizeValue(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDetailValue(item));
  if (value instanceof Error) {
    return {
      message: sanitizeValue(value.message),
      name: value.name,
      ...(value.cause == null ? {} : { cause: sanitizeDetailValue(value.cause) }),
    };
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, item]) => [
        entryKey,
        sanitizeDetailValue(item, entryKey),
      ]),
    );
  }
  return value;
};

/** @param {Record<string, unknown>} details */
const sanitizeDetails = (details) =>
  /** @type {Record<string, unknown>} */ (sanitizeDetailValue(details));

/** @param {() => Promise<void>} write */
const enqueueWrite = (write) => {
  pendingWrites = pendingWrites.then(write, write).catch(() => {
    // Diagnostics must never interrupt the action being measured.
  });
};

/** @param {string} path @param {Record<string, unknown>} record */
const appendRecord = (path, record) => {
  enqueueWrite(async () => {
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  });
};

/**
 * Start a fresh command log for this Electron session.
 * @param {string} logsDirectory
 * @param {{processStartedAt?: string}} [options]
 */
const configureCommandLog = (logsDirectory, options = {}) => {
  const path = process.env.CODIFF_COMMAND_LOG_PATH || join(logsDirectory, 'commands.jsonl');
  if (commandLogPath === path) {
    return path;
  }
  commandLogPath = path;
  nextTimingId = 0;
  enqueueWrite(async () => {
    const directory = dirname(path);
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    await writeFile(
      path,
      `${JSON.stringify({
        event: 'session-start',
        monotonicMs: 0,
        pid: process.pid,
        timestamp: options.processStartedAt || new Date().toISOString(),
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(path, 0o600);
  });
  return path;
};

/**
 * @param {{
 *   args?: ReadonlyArray<string>;
 *   command: string;
 *   cwd?: string;
 *   details?: Record<string, unknown>;
 *   kind?: 'action' | 'command';
 * }} input
 */
const startCommandTiming = (input) => {
  const path = commandLogPath;
  const contextActionId = actionContext.getStore()?.actionId;
  const implicitActionId =
    path && input.kind !== 'action' && !contextActionId ? (nextTimingId += 1) : null;
  const id = (nextTimingId += 1);
  const startedAt = performance.now();
  const startedTimestamp = new Date().toISOString();
  const parentActionId = contextActionId || implicitActionId;
  let finished = false;
  if (path) {
    if (implicitActionId) {
      appendRecord(path, {
        command: 'standalone-command',
        details: sanitizeDetails({ executable: input.command }),
        event: 'start',
        id: implicitActionId,
        kind: 'action',
        timestamp: startedTimestamp,
      });
    }
    appendRecord(path, {
      ...(input.args ? { args: sanitizeArgs(input.args) } : {}),
      ...(parentActionId ? { actionId: parentActionId } : {}),
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.details ? { details: sanitizeDetails(input.details) } : {}),
      event: 'start',
      id,
      kind: input.kind || 'command',
      timestamp: startedTimestamp,
    });
  }

  return {
    id,
    /** @param {{canceled?: boolean, error?: unknown, exitCode?: number | null, signal?: string | null, timedOut?: boolean}} [result] */
    finish: (result = {}) => {
      if (finished) {
        return;
      }
      finished = true;
      if (!path) {
        return;
      }
      const failed = result.error != null || (result.exitCode != null && result.exitCode !== 0);
      const errorOutcome = processErrorOutcome(result.error);
      const exitCode =
        result.exitCode ??
        errorOutcome.exitCode ??
        (input.kind !== 'action' && !failed && !result.canceled && !result.timedOut ? 0 : null);
      const signal = result.signal || errorOutcome.signal;
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const status = result.timedOut
        ? 'timeout'
        : result.canceled
          ? 'canceled'
          : failed
            ? 'error'
            : 'ok';
      appendRecord(path, {
        ...(parentActionId ? { actionId: parentActionId } : {}),
        ...(result.canceled ? { canceled: true } : {}),
        command: input.command,
        durationMs,
        ...(result.error != null
          ? { errorName: result.error instanceof Error ? result.error.name : 'Error' }
          : {}),
        event: 'finish',
        ...(exitCode != null ? { exitCode } : {}),
        id,
        kind: input.kind || 'command',
        ...(signal ? { signal } : {}),
        status,
        timestamp: new Date().toISOString(),
        ...(result.timedOut ? { timedOut: true } : {}),
      });
      if (implicitActionId) {
        appendRecord(path, {
          command: 'standalone-command',
          durationMs,
          event: 'finish',
          id: implicitActionId,
          kind: 'action',
          status,
          timestamp: new Date().toISOString(),
        });
      }
    },
  };
};

/** @param {string} name @param {{actionId?: number, details?: Record<string, unknown>, monotonicMs?: number, timestamp?: string}} [options] */
const recordCommandMilestone = (name, options = {}) => {
  if (!commandLogPath) {
    return;
  }
  appendRecord(commandLogPath, {
    actionId: options.actionId || actionContext.getStore()?.actionId,
    ...(options.details ? { details: sanitizeDetails(options.details) } : {}),
    event: 'milestone',
    monotonicMs: options.monotonicMs ?? performance.now(),
    name,
    timestamp: options.timestamp || new Date().toISOString(),
  });
};

/**
 * Return the cancellation boundary for the enclosing command action, if one
 * exists. Canonical process runners use this as their default signal so a
 * caller cannot accidentally leave a startup command outside its action.
 *
 * @returns {AbortSignal | undefined}
 */
const getCommandActionSignal = () => actionContext.getStore()?.signal;

/** @param {{command: string, cwd?: string, details?: Record<string, unknown>}} input */
const startCommandAction = (input) => {
  const timing = startCommandTiming({ ...input, kind: 'action' });
  const controller = new AbortController();
  let finished = false;

  /** @param {{canceled?: boolean, error?: unknown, exitCode?: number | null, signal?: string | null, timedOut?: boolean}} [result] */
  const finish = (result = {}) => {
    if (finished) {
      return;
    }
    finished = true;
    if (result.canceled && !controller.signal.aborted) {
      controller.abort();
    }
    timing.finish(result);
  };

  return {
    ...timing,
    cancel: () => finish({ canceled: true }),
    finish,
    signal: controller.signal,
    /** @template Value @param {() => Value} callback */
    run: (callback) =>
      actionContext.run({ actionId: timing.id, signal: controller.signal }, callback),
  };
};

/**
 * @template Value
 * @param {{command: string, cwd?: string, details?: Record<string, unknown>}} input
 * @param {() => Promise<Value>} callback
 */
const runWithCommandAction = async (input, callback) => {
  const timing = startCommandAction(input);
  return timing.run(async () => {
    try {
      const value = await callback();
      timing.finish();
      return value;
    } catch (error) {
      timing.finish({
        canceled: error instanceof Error && error.name === 'AbortError',
        error,
      });
      throw error;
    }
  });
};

const flushCommandLog = () => pendingWrites;
const disableCommandLog = () => {
  commandLogPath = null;
};

module.exports = {
  configureCommandLog,
  disableCommandLog,
  flushCommandLog,
  getCommandActionSignal,
  recordCommandMilestone,
  runWithCommandAction,
  sanitizeArgs,
  startCommandAction,
  startCommandTiming,
};
