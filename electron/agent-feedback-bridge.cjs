// @ts-check

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { formatAgentFeedbackMessage } = require('./agent-feedback-delivery.cjs');

const MAX_REGISTRATION_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PROTOCOL_VERSION = 1;
const STALE_AFTER_MS = 45_000;

const defaultIsPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const isPrivate = (metadata, uid) =>
  !metadata.isSymbolicLink() &&
  (uid === undefined || metadata.uid === uid) &&
  (metadata.mode & 0o077) === 0;

/**
 * @param {{getuid?: () => number; isPidAlive?: (pid: number) => boolean; now?: () => number; registrationRoot?: string; timeoutMs?: number}} [options]
 */
const createAgentFeedbackBridgeClient = ({
  getuid = process.getuid?.bind(process),
  isPidAlive = defaultIsPidAlive,
  now = Date.now,
  registrationRoot = path.join(os.homedir(), '.codiff', 'agent-feedback', 'v1'),
  timeoutMs = 10_000,
} = {}) => {
  const uid = getuid?.();

  /** @param {import('../core/types.ts').AgentFeedbackDeliveryRequest} request */
  const findRegistration = (request) => {
    const directory = path.join(registrationRoot, request.backend);
    let directoryMetadata;
    try {
      directoryMetadata = fs.lstatSync(directory);
    } catch {
      throw new Error('No authenticated agent feedback bridge is available.');
    }
    if (!directoryMetadata.isDirectory() || !isPrivate(directoryMetadata, uid)) {
      throw new Error('No authenticated agent feedback bridge is available.');
    }

    const registrations = [];
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const registrationPath = path.join(directory, name);
      try {
        const metadata = fs.lstatSync(registrationPath);
        if (
          !metadata.isFile() ||
          !isPrivate(metadata, uid) ||
          metadata.size > MAX_REGISTRATION_BYTES
        ) {
          continue;
        }
        const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
        const updatedAt = Date.parse(registration.updatedAt);
        if (
          registration.backend !== request.backend ||
          registration.protocolVersion !== PROTOCOL_VERSION ||
          registration.repositoryRoot !== request.repositoryRoot ||
          registration.sessionId !== request.sessionId ||
          typeof registration.endpoint !== 'string' ||
          typeof registration.instanceId !== 'string' ||
          !Number.isInteger(registration.pid) ||
          registration.pid <= 0 ||
          typeof registration.token !== 'string' ||
          !registration.token ||
          !Number.isFinite(updatedAt) ||
          now() - updatedAt > STALE_AFTER_MS ||
          !isPidAlive(registration.pid)
        ) {
          continue;
        }
        registrations.push({ ...registration, updatedAtMs: updatedAt });
      } catch {
        // Invalid or concurrently replaced registrations are not candidates.
      }
    }
    registrations.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    if (!registrations[0]) {
      throw new Error('No authenticated agent feedback bridge is available.');
    }
    return registrations[0];
  };

  /**
   * @param {Record<string, unknown>} registration
   * @param {string} requestPath
   * @param {Record<string, unknown>} body
   * @param {boolean} delivery
   */
  const post = (registration, requestPath, body, delivery) =>
    new Promise((resolve, reject) => {
      let bodyFinished = false;
      let dispatched = false;
      let settled = false;
      let timedOut = false;
      const fail = (error, ambiguous = false) => {
        if (settled) return;
        settled = true;
        const failure = error instanceof Error ? error : new Error(String(error));
        if (ambiguous) failure.ambiguous = true;
        reject(failure);
      };
      const outgoing = http.request(
        {
          headers: {
            authorization: `Bearer ${registration.token}`,
            'content-type': 'application/json',
          },
          method: 'POST',
          path: requestPath,
          socketPath: registration.endpoint,
          timeout: timeoutMs,
        },
        (incoming) => {
          const chunks = [];
          let bytes = 0;
          incoming.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              incoming.destroy(new Error('Agent feedback bridge response exceeds 64 KiB.'));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('error', (error) => fail(error, delivery && dispatched));
          incoming.on('end', () => {
            if (settled) return;
            const text = Buffer.concat(chunks).toString('utf8');
            if ((incoming.statusCode ?? 500) < 200 || (incoming.statusCode ?? 500) >= 300) {
              let reason;
              try {
                reason = JSON.parse(text).error;
              } catch {
                reason = undefined;
              }
              fail(new Error(reason || `Agent feedback bridge returned ${incoming.statusCode}.`));
              return;
            }
            try {
              const value = JSON.parse(text);
              settled = true;
              resolve(value);
            } catch {
              fail(
                new Error('Agent feedback bridge returned invalid JSON.'),
                delivery && dispatched,
              );
            }
          });
        },
      );
      outgoing.on('finish', () => {
        bodyFinished = true;
      });
      outgoing.on('timeout', () => {
        timedOut = true;
        outgoing.destroy(new Error('Agent feedback bridge request timed out.'));
      });
      outgoing.on('error', (error) => {
        fail(error, delivery && (timedOut || bodyFinished));
      });
      dispatched = true;
      outgoing.end(JSON.stringify(body));
    });

  /** @param {import('../core/types.ts').AgentFeedbackDeliveryRequest} request */
  const deliverToAgentFeedbackBridge = async (request) => {
    const registration = findRegistration(request);
    const nonce = randomUUID();
    const identity = await post(
      registration,
      '/v1/identity',
      { nonce, version: PROTOCOL_VERSION },
      false,
    );
    const expectedIdentity = {
      backend: request.backend,
      nonce,
      repositoryRoot: request.repositoryRoot,
      sessionId: request.sessionId,
      version: PROTOCOL_VERSION,
    };
    if (
      !identity ||
      typeof identity !== 'object' ||
      Object.keys(identity).sort().join('\0') !== Object.keys(expectedIdentity).sort().join('\0') ||
      Object.entries(expectedIdentity).some(([key, value]) => identity[key] !== value)
    ) {
      throw new Error('Agent feedback bridge identity challenge failed.');
    }
    return post(
      registration,
      '/v1/deliver',
      {
        deliveryId: request.deliveryId,
        message: formatAgentFeedbackMessage(request),
        repositoryRoot: request.repositoryRoot,
        sessionId: request.sessionId,
        version: PROTOCOL_VERSION,
      },
      true,
    );
  };

  return { deliverToAgentFeedbackBridge };
};

const defaultClient = createAgentFeedbackBridgeClient();

module.exports = {
  createAgentFeedbackBridgeClient,
  deliverToAgentFeedbackBridge: defaultClient.deliverToAgentFeedbackBridge,
};
