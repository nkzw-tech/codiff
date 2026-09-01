import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const MAX_BODY_BYTES = 1024 * 1024;
const PROTOCOL_VERSION = 1;
const VALID_BACKENDS = new Set(['claude', 'codex', 'opencode', 'pi']);

const sendJson = (response, statusCode, body) => {
  if (response.writableEnded) return;
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const authenticated = (header, token) => {
  const provided =
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const left = createHash('sha256').update(provided).digest();
  const right = createHash('sha256').update(token).digest();
  return timingSafeEqual(left, right) && provided.length === token.length;
};

const readJson = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Request body exceeds 1 MiB.'), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });

const writeRegistration = async (registrationPath, registration) => {
  const temporaryPath = `${registrationPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(registration), { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, registrationPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const ensurePrivateDirectory = async (directory, label, uid) => {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(directory, { mode: 0o700, recursive: true });
    metadata = await lstat(directory);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Agent feedback ${label} must be a directory, not a symlink.`);
  }
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`Agent feedback ${label} has the wrong owner.`);
  }
  await chmod(directory, 0o700);
};

/**
 * @param {{backend: string; deliver: (request: {deliveryId: string; message: string; repositoryRoot: string; sessionId: string; version: number}) => Promise<Record<string, unknown>>; getIdentity: () => {repositoryRoot: string; sessionId: string} | Promise<{repositoryRoot: string; sessionId: string}>; getuid?: () => number; now?: () => Date; onDiagnostic?: (message: string) => void; registrationRoot?: string; socketDirectory?: string; refreshIntervalMs?: number; writeRegistrationFile?: (registrationPath: string, registration: Record<string, unknown>) => Promise<void>}} options
 */
export const createAgentFeedbackBridge = async ({
  backend,
  deliver,
  getIdentity,
  getuid = process.getuid?.bind(process),
  now = () => new Date(),
  onDiagnostic = (message) => console.error(message),
  refreshIntervalMs = 15_000,
  registrationRoot = path.join(os.homedir(), '.codiff', 'agent-feedback', 'v1'),
  socketDirectory = os.tmpdir(),
  writeRegistrationFile = writeRegistration,
}) => {
  if (!VALID_BACKENDS.has(backend)) {
    throw new Error('Agent feedback backend is invalid.');
  }
  const { repositoryRoot, sessionId } = await getIdentity();
  const instanceId = randomUUID();
  const registrationDirectory = path.join(registrationRoot, backend);
  const encodedSession = Buffer.from(sessionId).toString('base64url');
  const registrationPath = path.join(
    registrationDirectory,
    `${encodedSession}-${process.pid}-${instanceId}.json`,
  );
  const endpoint = path.join(socketDirectory, `codiff-${instanceId.slice(0, 12)}.sock`);
  const registration = {
    backend,
    endpoint,
    instanceId,
    pid: process.pid,
    protocolVersion: PROTOCOL_VERSION,
    repositoryRoot,
    sessionId,
    token: randomBytes(32).toString('base64url'),
    updatedAt: now().toISOString(),
  };
  const terminal = new Map();
  const inFlight = new Map();
  const connections = new Set();
  let registrationWrite = Promise.resolve();
  let closed = false;
  let closePromise;

  const remember = (deliveryId, response) => {
    terminal.set(deliveryId, response);
    if (terminal.size > 1_000) terminal.delete(terminal.keys().next().value);
  };

  const queueRegistrationWrite = () => {
    registrationWrite = registrationWrite
      .catch(() => {})
      .then(() => writeRegistrationFile(registrationPath, registration));
    return registrationWrite;
  };

  const server = http.createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      (request.url !== '/v1/identity' && request.url !== '/v1/deliver')
    ) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    if (!authenticated(request.headers.authorization, registration.token)) {
      sendJson(response, 401, { error: 'Unauthorized.' });
      return;
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(response, 400, { error: 'Request body must be an object.' });
      return;
    }

    if (request.url === '/v1/identity') {
      if (body.version !== PROTOCOL_VERSION || typeof body.nonce !== 'string' || !body.nonce) {
        sendJson(response, 400, { error: 'Invalid identity challenge.' });
        return;
      }
      sendJson(response, 200, {
        backend,
        nonce: body.nonce,
        repositoryRoot,
        sessionId,
        version: PROTOCOL_VERSION,
      });
      return;
    }

    if (
      body.repositoryRoot !== repositoryRoot ||
      body.sessionId !== sessionId ||
      body.version !== PROTOCOL_VERSION
    ) {
      sendJson(response, 409, { error: 'Delivery identity does not match this bridge.' });
      return;
    }
    if (
      typeof body.deliveryId !== 'string' ||
      !body.deliveryId ||
      typeof body.message !== 'string'
    ) {
      sendJson(response, 400, { error: 'Invalid delivery request.' });
      return;
    }

    const previous = terminal.get(body.deliveryId);
    if (previous) {
      sendJson(response, 200, { ...previous, status: 'already-accepted' });
      return;
    }
    let operation = inFlight.get(body.deliveryId);
    if (!operation) {
      operation = deliver({
        deliveryId: body.deliveryId,
        message: body.message,
        repositoryRoot,
        sessionId,
        version: PROTOCOL_VERSION,
      });
      inFlight.set(body.deliveryId, operation);
    }
    try {
      const result = await operation;
      if (['accepted', 'queued', 'already-accepted'].includes(result?.status)) {
        remember(body.deliveryId, result);
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Delivery failed.',
      });
    } finally {
      if (inFlight.get(body.deliveryId) === operation) inFlight.delete(body.deliveryId);
    }
  });
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });

  const closeServer = () =>
    new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  const removeInstanceFiles = () =>
    Promise.all([rm(registrationPath, { force: true }), rm(endpoint, { force: true })]);

  await ensurePrivateDirectory(registrationRoot, 'registry root', getuid?.());
  await ensurePrivateDirectory(registrationDirectory, 'backend directory', getuid?.());
  try {
    await rm(endpoint, { force: true });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    await chmod(endpoint, 0o600);
    await queueRegistrationWrite();
  } catch (error) {
    for (const connection of connections) connection.destroy();
    await closeServer();
    await removeInstanceFiles();
    throw error;
  }

  const refresh = setInterval(() => {
    if (closed) return;
    registration.updatedAt = now().toISOString();
    void queueRegistrationWrite().catch(() => {
      try {
        onDiagnostic('Agent feedback bridge registration refresh failed.');
      } catch {
        // Diagnostics must not stop future registration refreshes.
      }
    });
  }, refreshIntervalMs);
  refresh.unref?.();

  const close = () => {
    if (!closePromise) {
      closePromise = (async () => {
        closed = true;
        clearInterval(refresh);
        for (const connection of connections) connection.destroy();
        await closeServer();
        await registrationWrite.catch(() => {});
        await removeInstanceFiles();
      })();
    }
    return closePromise;
  };

  return { close, registration, registrationDirectory, registrationPath };
};
