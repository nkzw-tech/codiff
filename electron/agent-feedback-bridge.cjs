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
const VALID_BACKENDS = new Set(['claude', 'codex', 'opencode', 'pi']);
const assurances = {
  claude: new Set(['transport-write']),
  codex: new Set(['queue-command']),
  opencode: new Set(['bridge-queue', 'message-created']),
  pi: new Set(['dispatch-started']),
};

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

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

  /** @param {{backend: import('../core/types.ts').AgentBackend; repositoryRoot: string; sessionId: string}} identity */
  const findRegistrations = (identity) => {
    if (!VALID_BACKENDS.has(identity.backend)) {
      throw new Error('No authenticated agent feedback bridge is available.');
    }
    const directory = path.join(registrationRoot, identity.backend);
    let rootMetadata;
    let directoryMetadata;
    try {
      rootMetadata = fs.lstatSync(registrationRoot);
      directoryMetadata = fs.lstatSync(directory);
    } catch {
      throw new Error('No authenticated agent feedback bridge is available.');
    }
    if (
      !rootMetadata.isDirectory() ||
      !isPrivate(rootMetadata, uid) ||
      !directoryMetadata.isDirectory() ||
      !isPrivate(directoryMetadata, uid)
    ) {
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
        const registrationText = fs.readFileSync(registrationPath, 'utf8');
        const registration = JSON.parse(registrationText);
        const updatedAt =
          typeof registration.updatedAt === 'string' ? Date.parse(registration.updatedAt) : NaN;
        const validPid = Number.isInteger(registration.pid) && registration.pid > 0;
        if (
          registration.backend !== identity.backend ||
          registration.protocolVersion !== PROTOCOL_VERSION ||
          !isNonEmptyString(registration.repositoryRoot) ||
          !isNonEmptyString(registration.sessionId) ||
          !isNonEmptyString(registration.endpoint) ||
          !isNonEmptyString(registration.instanceId) ||
          !validPid ||
          !isNonEmptyString(registration.token) ||
          !Number.isFinite(updatedAt)
        ) {
          continue;
        }
        const stale = now() - updatedAt > STALE_AFTER_MS || updatedAt - now() > STALE_AFTER_MS;
        const dead = validPid && !isPidAlive(registration.pid);
        if (stale || dead) {
          const quarantinePath = `${registrationPath}.stale-${randomUUID()}`;
          try {
            fs.renameSync(registrationPath, quarantinePath);
          } catch {
            continue;
          }
          const claimedMetadata = fs.lstatSync(quarantinePath);
          const claimedStaleFile =
            claimedMetadata.isFile() &&
            isPrivate(claimedMetadata, uid) &&
            claimedMetadata.ino === metadata.ino &&
            claimedMetadata.mtimeMs === metadata.mtimeMs &&
            claimedMetadata.size === metadata.size &&
            fs.readFileSync(quarantinePath, 'utf8') === registrationText;
          if (!claimedStaleFile) {
            try {
              fs.linkSync(quarantinePath, registrationPath);
            } catch (error) {
              if (error?.code !== 'EEXIST') throw error;
            }
          }
          fs.rmSync(quarantinePath, { force: true });
          continue;
        }
        if (
          registration.repositoryRoot !== identity.repositoryRoot ||
          registration.sessionId !== identity.sessionId
        ) {
          continue;
        }
        registrations.push({ ...registration, updatedAtMs: updatedAt });
      } catch {
        // Invalid or concurrently replaced registrations are not candidates.
      }
    }
    registrations.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    if (registrations.length === 0) {
      throw new Error('No authenticated agent feedback bridge is available.');
    }
    return registrations;
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
      let deadline;
      const finish = () => {
        if (deadline) clearTimeout(deadline);
        settled = true;
      };
      const fail = (error, ambiguous = false) => {
        if (settled) return;
        finish();
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
              finish();
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
      outgoing.on('error', (error) => {
        fail(error, delivery && bodyFinished);
      });
      deadline = setTimeout(() => {
        const error = new Error('Agent feedback bridge request timed out.');
        fail(error, delivery && dispatched);
        outgoing.destroy(error);
      }, timeoutMs);
      dispatched = true;
      outgoing.end(JSON.stringify(body));
    });

  const identityMatches = (identity, expectedIdentity) =>
    identity &&
    typeof identity === 'object' &&
    Object.keys(identity).sort().join('\0') === Object.keys(expectedIdentity).sort().join('\0') &&
    Object.entries(expectedIdentity).every(([key, value]) => identity[key] === value);

  /** @param {{backend: import('../core/types.ts').AgentBackend; repositoryRoot: string; sessionId: string}} identity */
  const findAuthenticatedRegistration = async (identity) => {
    for (const candidate of findRegistrations(identity)) {
      const nonce = randomUUID();
      try {
        const response = await post(
          candidate,
          '/v1/identity',
          { nonce, version: PROTOCOL_VERSION },
          false,
        );
        if (
          identityMatches(response, {
            backend: identity.backend,
            nonce,
            repositoryRoot: identity.repositoryRoot,
            sessionId: identity.sessionId,
            version: PROTOCOL_VERSION,
          })
        ) {
          return candidate;
        }
      } catch {
        // A live PID can have an orphaned socket or belong to a reused process.
      }
    }
    throw new Error('No authenticated agent feedback bridge is available.');
  };

  /** @param {{backend: import('../core/types.ts').AgentBackend; repositoryRoot: string; sessionId: string}} identity */
  const probeAgentFeedbackBridge = async (identity) => {
    try {
      await findAuthenticatedRegistration(identity);
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : 'Agent feedback bridge is unavailable.',
      };
    }
  };

  const validateDeliveryResponse = (request, response) => {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('Agent feedback bridge acknowledgement is invalid.');
    }
    if (response.deliveryId !== request.deliveryId) {
      throw new Error('Agent feedback bridge acknowledgement has the wrong delivery ID.');
    }
    if (response.status === 'rejected') {
      if (
        Object.keys(response).sort().join('\0') !== 'deliveryId\0reason\0status' ||
        typeof response.reason !== 'string' ||
        response.reason.trim() === ''
      ) {
        throw new Error('Agent feedback bridge rejection is invalid.');
      }
      return;
    }
    if (
      Object.keys(response).sort().join('\0') !== 'assurance\0deliveryId\0status' ||
      !['accepted', 'queued', 'already-accepted'].includes(response.status) ||
      !assurances[request.backend].has(response.assurance)
    ) {
      throw new Error('Agent feedback bridge acknowledgement is invalid for this backend.');
    }
  };

  /** @param {import('../core/types.ts').AgentFeedbackDeliveryRequest} request */
  const deliverToAgentFeedbackBridge = async (request) => {
    const registration = await findAuthenticatedRegistration(request);
    const response = await post(
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
    try {
      validateDeliveryResponse(request, response);
      return response;
    } catch (error) {
      error.ambiguous = true;
      throw error;
    }
  };

  return { deliverToAgentFeedbackBridge, probeAgentFeedbackBridge };
};

const defaultClient = createAgentFeedbackBridgeClient();

module.exports = {
  createAgentFeedbackBridgeClient,
  deliverToAgentFeedbackBridge: defaultClient.deliverToAgentFeedbackBridge,
  probeAgentFeedbackBridge: defaultClient.probeAgentFeedbackBridge,
};
