// @ts-check

const { resolveAgentCommandTransport } = require('./agent-command.cjs');
const { getCommandEnvironment } = require('./login-shell-environment.cjs');
const { getPiCommand, PI_MODELS } = require('./pi.cjs');
const { oneLine } = require('./agent-shared.cjs');

const PI_MODEL_DISCOVERY_TIMEOUT_MS = 8_000;

/**
 * Cache populated catalogs, but retry a default-only result after Pi is configured.
 * @param {{
 *   readModels: () => Promise<ReadonlyArray<{id: string; label: string}>>;
 *   onModels: (models: ReadonlyArray<{id: string; label: string}>) => void;
 * }} options
 */
const createPiModelCatalogLoader = ({ readModels, onModels }) => {
  /** @type {Promise<void> | undefined} */
  let discovery;
  return () => {
    discovery ??= Promise.resolve()
      .then(readModels)
      .then((models) => {
        onModels(models);
        if (models.length <= PI_MODELS.length) discovery = undefined;
      })
      .catch(() => {
        discovery = undefined;
      });
    return discovery;
  };
};

/**
 * Read the installed Pi CLI's model list without starting an inference turn.
 * @param {{
 *   commandTransport?: import('./agent-command.cjs').AgentCommandTransport;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 * }} [options]
 * @returns {Promise<ReadonlyArray<{id: string; label: string}>>}
 */
const readPiModels = async (options = {}) => {
  if (options.signal?.aborted) {
    throw new Error('Pi model discovery was cancelled.');
  }
  const environment = await getCommandEnvironment();
  if (options.signal?.aborted) {
    throw new Error('Pi model discovery was cancelled.');
  }
  const transport = resolveAgentCommandTransport(options.commandTransport, getPiCommand);
  const child = transport.spawn(transport.command, ['--no-approve', '--list-models'], {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let finished = false;
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(
      () => finish(new Error('Pi model discovery timed out.'), [], true),
      options.timeoutMs ?? PI_MODEL_DISCOVERY_TIMEOUT_MS,
    );

    /** @param {Error | null} error @param {ReadonlyArray<{id: string; label: string}>} [models] @param {boolean} [stopChild] */
    const finish = (error, models = [], stopChild = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (stopChild) {
        child.stdin.end();
        child.kill('SIGTERM');
        if (options.signal?.aborted) {
          child.kill('SIGKILL');
        } else {
          const killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
          killTimer.unref();
          child.once('close', () => clearTimeout(killTimer));
        }
      }
      if (error) reject(error);
      else resolve(models);
    };
    const onAbort = () => finish(new Error('Pi model discovery was cancelled.'), [], true);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4_096);
    });
    child.stdin.on('error', (error) => finish(error, [], true));
    child.on('error', (error) => finish(error, [], true));
    child.on('close', (code, signal) => {
      if (code !== 0) {
        finish(
          new Error(
            oneLine(
              stderr || stdout,
              signal ? `Pi was terminated by ${signal}.` : `Pi exited with code ${code}.`,
            ),
          ),
        );
        return;
      }

      const lines = stdout.split(/\r?\n/);
      const headerIndex = lines.findIndex((line) => {
        const [provider, model] = line.trim().split(/\s{2,}/);
        return provider?.toLowerCase() === 'provider' && model?.toLowerCase() === 'model';
      });
      const models = new Map(PI_MODELS.map((model) => [model.id, model]));
      const modelLines = headerIndex < 0 ? [] : lines.slice(headerIndex + 1);
      for (const line of modelLines) {
        const [provider, model] = line.trim().split(/\s{2,}/);
        if (!provider || !model) continue;
        const id = `${provider}/${model}`;
        models.set(id, { id, label: id });
      }
      finish(null, [...models.values()]);
    });

    child.stdin.end();
  });
};

module.exports = { createPiModelCatalogLoader, readPiModels };
