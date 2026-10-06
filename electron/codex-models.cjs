// @ts-check

const { createInterface } = require('node:readline');
const { resolveAgentCommandTransport } = require('./agent-command.cjs');
const { getCodexCommand } = require('./codex.cjs');
const { getCommandEnvironment } = require('./login-shell-environment.cjs');

/**
 * @typedef {{
 *   id: string;
 *   label: string;
 *   reasoningEfforts: ReadonlyArray<string>;
 * }} CodexModel
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read the installed CLI's picker catalog without starting an inference turn.
 * @param {{
 *   commandTransport?: import('./agent-command.cjs').AgentCommandTransport;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 * }} [options]
 * @returns {Promise<ReadonlyArray<CodexModel>>}
 */
const readCodexModels = async (options = {}) => {
  const environment = await getCommandEnvironment();
  if (options.signal?.aborted) {
    throw new Error('Codex model discovery was cancelled.');
  }
  const transport = resolveAgentCommandTransport(options.commandTransport, getCodexCommand);
  const child = transport.spawn(transport.command, ['app-server', '--stdio'], {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });

  return new Promise((resolve, reject) => {
    let finished = false;
    let requestId = 0;
    let stderr = '';
    /** @type {{id: number; resolve: (value: unknown) => void; reject: (error: Error) => void} | undefined} */
    let pending;
    const timer = setTimeout(
      () => finish(new Error('Codex model discovery timed out.')),
      options.timeoutMs ?? 8_000,
    );

    /** @param {Error | null} error @param {ReadonlyArray<CodexModel>} [models] */
    const finish = (error, models = []) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      lines.close();
      child.stdin.end();
      child.kill('SIGTERM');
      if (options.signal?.aborted) {
        child.kill('SIGKILL');
      } else {
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
        killTimer.unref();
        child.once('close', () => clearTimeout(killTimer));
      }
      pending?.reject(error || new Error('Codex model discovery finished.'));
      pending = undefined;
      if (error) reject(error);
      else resolve(models);
    };
    const onAbort = () => finish(new Error('Codex model discovery was cancelled.'));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    /** @param {unknown} message */
    const send = (message) => {
      if (!finished) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    /** @param {string} method @param {unknown} params @returns {Promise<unknown>} */
    const request = (method, params) =>
      new Promise((resolveRequest, rejectRequest) => {
        if (finished) {
          rejectRequest(new Error('Codex model discovery finished.'));
          return;
        }
        requestId += 1;
        pending = { id: requestId, resolve: resolveRequest, reject: rejectRequest };
        send({ id: requestId, method, params });
      });

    lines.on('line', (line) => {
      if (finished) return;
      try {
        /** @type {unknown} */
        const message = JSON.parse(line);
        if (!isRecord(message)) return;
        if (typeof message.method === 'string' && message.id != null) {
          send({
            id: message.id,
            error: {
              code: -32601,
              message: 'Model discovery does not handle interactive requests.',
            },
          });
          return;
        }
        if (typeof message.id !== 'number') return;
        const entry = pending;
        if (!entry || entry.id !== message.id) return;
        pending = undefined;
        if (message.error) {
          entry.reject(
            new Error(
              isRecord(message.error) && typeof message.error.message === 'string'
                ? message.error.message
                : 'Codex model discovery failed.',
            ),
          );
        } else entry.resolve(message.result);
      } catch {
        finish(new Error('Codex returned an invalid model catalog response.'));
      }
    });
    lines.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4_096);
    });
    child.stdin.on('error', (error) => finish(error));
    child.on('error', (error) => finish(error));
    child.on('close', () =>
      finish(new Error(stderr.trim() || 'Codex exited before returning its model catalog.')),
    );

    void (async () => {
      await request('initialize', {
        clientInfo: { name: 'codiff', title: 'Codiff', version: '1' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      send({ method: 'initialized' });
      /** @type {Map<string, CodexModel>} */
      const models = new Map();
      const cursors = new Set();
      let cursor;
      do {
        const page = await request('model/list', {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        });
        if (!isRecord(page) || !Array.isArray(page.data)) {
          throw new Error('Codex returned an invalid model catalog.');
        }
        for (const item of page.data) {
          if (!isRecord(item) || item.hidden === true) continue;
          const id =
            typeof item.model === 'string'
              ? item.model.trim()
              : typeof item.id === 'string'
                ? item.id.trim()
                : '';
          if (!id) continue;
          const efforts = Array.isArray(item.supportedReasoningEfforts)
            ? item.supportedReasoningEfforts.flatMap((option) =>
                isRecord(option) &&
                typeof option.reasoningEffort === 'string' &&
                option.reasoningEffort.trim()
                  ? [option.reasoningEffort.trim()]
                  : [],
              )
            : [];
          models.set(id, {
            id,
            label:
              typeof item.displayName === 'string' && item.displayName.trim()
                ? item.displayName.trim()
                : id,
            reasoningEfforts: [...new Set(efforts)],
          });
        }
        if (page.nextCursor != null && typeof page.nextCursor !== 'string') {
          throw new Error('Codex returned an invalid model catalog cursor.');
        }
        cursor = page.nextCursor || undefined;
        if (cursor && cursors.has(cursor))
          throw new Error('Codex repeated a model catalog cursor.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      finish(null, [...models.values()]);
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
};

module.exports = { readCodexModels };
