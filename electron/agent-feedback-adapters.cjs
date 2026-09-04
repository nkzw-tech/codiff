// @ts-check

const { spawn } = require('node:child_process');
const {
  deliverToAgentFeedbackBridge,
  probeAgentFeedbackBridge,
} = require('./agent-feedback-bridge.cjs');
const { formatAgentFeedbackMessage } = require('./agent-feedback-delivery.cjs');

const CODEX_INPUT_BYTES = 24 * 1024;
const MAX_OUTPUT_BYTES = 1_048_576;
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;

const ambiguousError = (message) => Object.assign(new Error(message), { ambiguous: true });

/**
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {{maxOutputBytes: number; spawnProcess: typeof spawn; timeoutMs: number}} options
 */
const spawnCapture = (command, args, { maxOutputBytes, spawnProcess, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];
    let outputBytes = 0;
    let pendingError;
    let settled = false;
    let timer;
    let terminationTimer;
    const settleError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      reject(error);
    };
    const terminate = (error) => {
      if (settled || pendingError) return;
      pendingError = error;
      clearTimeout(timer);
      child.kill('SIGTERM');
      terminationTimer = setTimeout(() => {
        child.kill('SIGKILL');
        terminationTimer = setTimeout(
          () => settleError(pendingError),
          PROCESS_TERMINATION_GRACE_MS,
        );
        terminationTimer.unref?.();
      }, PROCESS_TERMINATION_GRACE_MS);
      terminationTimer.unref?.();
    };
    /** @param {Array<Buffer>} output @param {unknown} value */
    const append = (output, value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate(ambiguousError('Codex queue output exceeded its limit.'));
        return;
      }
      output.push(chunk);
    };
    timer = setTimeout(() => terminate(ambiguousError('Codex queue timed out.')), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      if (!settled && !pendingError) append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (!settled && !pendingError) append(stderr, chunk);
    });
    child.once('error', (error) => {
      if (pendingError) return;
      if (error?.code !== 'ENOENT') error.ambiguous = true;
      settleError(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (pendingError) {
        settleError(pendingError);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });

/** @param {{bridgeProbe?: typeof probeAgentFeedbackBridge; spawnProcess?: typeof spawn}} [options] */
const createAgentFeedbackAdapters = ({
  bridgeProbe = probeAgentFeedbackBridge,
  spawnProcess = spawn,
} = {}) => {
  const capture = (args) =>
    spawnCapture('codex', args, {
      maxOutputBytes: MAX_OUTPUT_BYTES,
      spawnProcess,
      timeoutMs: PROCESS_TIMEOUT_MS,
    });
  const residentAdapter = {
    /** @param {import('../core/types.ts').AgentFeedbackDeliveryRequest} request */
    deliver(request) {
      if (Buffer.byteLength(formatAgentFeedbackMessage(request), 'utf8') > MAX_OUTPUT_BYTES) {
        throw new Error('Agent feedback exceeds 1 MiB. Shorten the review or use Copy Comments.');
      }
      return deliverToAgentFeedbackBridge(request);
    },
    probe: bridgeProbe,
  };

  return {
    claude: residentAdapter,
    codex: {
      /** @param {import('../core/types.ts').AgentFeedbackDeliveryRequest} request */
      async deliver(request) {
        const message = formatAgentFeedbackMessage(request);
        if (Buffer.byteLength(message, 'utf8') > CODEX_INPUT_BYTES) {
          throw new Error(
            'Codex feedback exceeds 24 KiB. Shorten the review or use Copy Comments.',
          );
        }
        const result = await capture([
          'queue',
          '--thread',
          request.sessionId,
          '--message',
          message,
        ]);
        if (result.signal) {
          throw ambiguousError(`Codex queue was terminated by ${result.signal}.`);
        }
        if (result.code !== 0) {
          const reason = result.stderr.trim();
          if (reason) throw new Error(reason);
          throw ambiguousError(`Codex queue exited with status ${result.code}.`);
        }
        const match = result.stdout
          .trim()
          .match(/^Queued message (.+) for thread ([0-9a-f-]+)\.$/i);
        if (!match || match[2] !== request.sessionId) {
          throw ambiguousError('Codex returned an unexpected queue acknowledgement.');
        }
        return {
          assurance: 'queue-command',
          deliveryId: request.deliveryId,
          status: 'queued',
        };
      },
      async probe() {
        try {
          const result = await capture(['queue', '--help']);
          if (
            result.code === 0 &&
            !result.signal &&
            /(^|\s)--thread(?:[=\s]|$)/m.test(result.stdout) &&
            /(^|\s)--message(?:[=\s]|$)/m.test(result.stdout)
          ) {
            return { available: true };
          }
          return {
            available: false,
            reason: 'Codex does not expose the required --thread and --message queue capability.',
          };
        } catch (error) {
          return {
            available: false,
            reason:
              error?.code === 'ENOENT'
                ? 'The Codex executable was not found.'
                : `The Codex queue capability is unavailable: ${error.message}`,
          };
        }
      },
    },
    opencode: residentAdapter,
    pi: residentAdapter,
  };
};

const createAgentFeedbackAdapterRegistry = () => {
  const adapters = new Map();
  return {
    /** @param {import('../core/types.ts').AgentFeedbackDeliveryRequest} request */
    deliver(request) {
      const adapter = adapters.get(request.backend);
      if (!adapter) {
        throw new Error(`The ${request.backend} feedback adapter is unavailable.`);
      }
      return adapter.deliver(request);
    },
    /** @param {import('../core/types.ts').AgentFeedbackSessionIdentity} identity */
    probe(identity) {
      const adapter = adapters.get(identity.backend);
      return adapter
        ? adapter.probe(identity)
        : Promise.resolve({
            available: false,
            reason: `The ${identity.backend} feedback adapter is unavailable.`,
          });
    },
    /**
     * @param {import('../core/types.ts').AgentBackend} backend
     * @param {{deliver: (request: import('../core/types.ts').AgentFeedbackDeliveryRequest) => Promise<import('../core/types.ts').AgentFeedbackDeliveryResponse>; probe: (identity: import('../core/types.ts').AgentFeedbackSessionIdentity) => Promise<{available: boolean; reason?: string}>}} adapter
     */
    register(backend, adapter) {
      adapters.set(backend, adapter);
    },
  };
};

module.exports = { createAgentFeedbackAdapterRegistry, createAgentFeedbackAdapters };
