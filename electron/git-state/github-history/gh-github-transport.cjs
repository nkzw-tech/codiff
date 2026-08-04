// @ts-check

/**
 * gh-backed GitHubTransport for local Codiff.
 * Keeps executable discovery, process spawning, and credentials in Electron.
 */

const { spawn } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { findExecutableOnPath, isExecutableFile } = require('../../agent-shared.cjs');
const { getCommandEnvironment } = require('../../login-shell-environment.cjs');

const GH_NOT_FOUND_CODE = 'GH_NOT_FOUND';
const GH_NOT_FOUND_MESSAGE =
  'GitHub support requires gh. Install gh, authenticate it, and verify `gh --version` works in Terminal. Codiff searches PATH, ~/.local/bin/gh, /opt/homebrew/bin/gh, and /usr/local/bin/gh. If gh is installed somewhere else, quit Codiff, then launch it with `CODIFF_GH_PATH=/absolute/path/to/gh codiff`.';
const DEFAULT_PROVIDER_OUTPUT_BYTES = 8 * 1024 * 1024;
class ProviderOutputLimitError extends Error {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    super(`gh api response exceeded the ${maxBytes}-byte safety limit.`);
    this.name = 'ProviderOutputLimitError';
  }
}

/** @typedef {{errorName?: string, maxBytes?: number, outputLimitExceeded: boolean, promise: Promise<Buffer>, status: 'pending' | 'fulfilled' | 'rejected'}} SharedGetRequest */

const sharedGetRequests = new Map();
const SHARED_GET_RETENTION_MS = 30_000;
const MAX_STDERR_BYTES = 1024 * 1024;

/** @param {number | undefined} maxBytes */
const normalizeMaxBytes = (maxBytes) => {
  if (maxBytes == null) {
    return DEFAULT_PROVIDER_OUTPUT_BYTES;
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a finite non-negative number.');
  }
  return Math.floor(maxBytes);
};

/** @param {number | undefined} current @param {number | undefined} requested */
const mergeMaxBytes = (current, requested) =>
  current == null || requested == null ? undefined : Math.max(current, requested);

/** @param {Buffer} bytes @param {number | undefined} maxBytes */
const enforceOutputLimit = (bytes, maxBytes) => {
  if (maxBytes != null && bytes.length > maxBytes) {
    throw new ProviderOutputLimitError(maxBytes);
  }
  return bytes;
};

/**
 * Share only uncancelable GETs, briefly retaining completed bytes so each
 * consumer can enforce its own response bound. Concurrent consumers may raise
 * the acquisition bound until output crosses it; a later larger consumer
 * starts a new read only after an earlier bounded read discarded bytes.
 * @param {string} key
 * @param {number | undefined} maxBytes
 * @param {(options: {getMaxBytes: () => number | undefined, onOutputLimit: () => void}) => Promise<Buffer>} read
 * @returns {Promise<Buffer>}
 */
const readSharedGet = (key, maxBytes, read) => {
  /** @type {SharedGetRequest | undefined} */
  const existing = sharedGetRequests.get(key);
  if (existing) {
    if (existing.status === 'fulfilled') {
      return existing.promise;
    }
    const canReuseLimitFailure =
      existing.maxBytes == null || (maxBytes != null && maxBytes <= existing.maxBytes);
    if (
      existing.status === 'rejected' &&
      (existing.errorName !== 'ProviderOutputLimitError' || canReuseLimitFailure)
    ) {
      return existing.promise;
    }
    if (existing.status === 'pending' && (!existing.outputLimitExceeded || canReuseLimitFailure)) {
      if (!existing.outputLimitExceeded) {
        existing.maxBytes = mergeMaxBytes(existing.maxBytes, maxBytes);
      }
      return existing.promise;
    }
  }

  /** @type {SharedGetRequest} */
  const entry = {
    maxBytes,
    outputLimitExceeded: false,
    promise: /** @type {Promise<Buffer>} */ (Promise.resolve(Buffer.alloc(0))),
    status: 'pending',
  };
  const request = Promise.resolve().then(() =>
    read({
      getMaxBytes: () => entry.maxBytes,
      onOutputLimit: () => {
        entry.outputLimitExceeded = true;
      },
    }),
  );
  entry.promise = request;
  sharedGetRequests.set(key, entry);
  const expire = () => {
    const timeout = setTimeout(() => {
      if (sharedGetRequests.get(key) === entry) {
        sharedGetRequests.delete(key);
      }
    }, SHARED_GET_RETENTION_MS);
    timeout.unref?.();
  };
  request.then(
    () => {
      entry.status = 'fulfilled';
      expire();
    },
    (error) => {
      entry.errorName = error instanceof Error ? error.name : undefined;
      entry.status = 'rejected';
      expire();
    },
  );
  return request;
};

/** @param {string} [detail] */
const createGhNotFoundError = (detail) => {
  const error = /** @type {Error & { code?: string }} */ (
    new Error(detail ? `${GH_NOT_FOUND_MESSAGE} ${detail}` : GH_NOT_FOUND_MESSAGE)
  );
  error.code = GH_NOT_FOUND_CODE;
  return error;
};

const getGhCommand = () => {
  const ghPath = process.env.CODIFF_GH_PATH?.trim();
  if (ghPath) {
    if (isExecutableFile(ghPath)) {
      return ghPath;
    }
    throw createGhNotFoundError(
      `CODIFF_GH_PATH is set to ${JSON.stringify(ghPath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('gh');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.local/bin/gh'),
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createGhNotFoundError();
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 * @param {{getMaxBytes?: () => number | undefined, maxBytes?: number, onOutputLimit?: () => void, signal?: AbortSignal}} [options]
 * @returns {Promise<Buffer>}
 */
const runGhApiBuffer = async (repoRoot, args, input, options = {}) => {
  const environment = await getCommandEnvironment();
  return new Promise((resolve, reject) => {
    const fixedMaxBytes = normalizeMaxBytes(options.maxBytes);
    let command;
    try {
      command = getGhCommand();
    } catch (error) {
      reject(error);
      return;
    }

    const child = spawn(command, ['api', ...args], {
      cwd: repoRoot,
      env: environment,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];
    let stderrBytes = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let forceKillTimeout;
    let outputBytes = 0;
    let outputLimit;
    const terminate = () => {
      child.kill('SIGTERM');
      forceKillTimeout ??= setTimeout(() => child.kill('SIGKILL'), 1_000);
      forceKillTimeout.unref?.();
    };
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputLimit != null) {
        return;
      }
      const maxBytes = options.getMaxBytes?.() ?? fixedMaxBytes;
      if (maxBytes != null && outputBytes > maxBytes) {
        outputLimit = maxBytes;
        stdout.length = 0;
        options.onOutputLimit?.();
        terminate();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const retained = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
      stderr.push(Buffer.from(retained));
      stderrBytes += retained.length;
    });
    child.on('error', (error) => {
      if (outputLimit != null) {
        reject(new ProviderOutputLimitError(outputLimit));
        return;
      }
      reject(
        /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
          ? createGhNotFoundError()
          : error,
      );
    });
    child.on('close', (code) => {
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      if (outputLimit != null) {
        reject(new ProviderOutputLimitError(outputLimit));
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(stdout, outputBytes));
      } else {
        const error = new Error(
          Buffer.concat(stderr).toString('utf8').trim() || `gh api exited with code ${code}.`,
        );
        reject(error);
      }
    });
    if (input == null) {
      child.stdin.end();
    } else {
      child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    }
  });
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 * @param {{buffer?: boolean, maxBytes?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<string | Buffer>}
 */
const runGhApi = async (repoRoot, args, input, options = {}) => {
  const bytes = await runGhApiBuffer(repoRoot, args, input, options);
  return options.buffer ? bytes : bytes.toString('utf8');
};

/**
 * gh writes paginated JSON documents consecutively. Parse complete arrays or
 * objects without assuming a newline separator.
 * @param {string} text
 */
const parseJsonDocuments = (text) => {
  /** @type {Array<unknown>} */
  const documents = [];
  let depth = 0;
  let escape = false;
  let inString = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start === -1) {
      if (/\s/.test(character)) continue;
      if (character !== '[' && character !== '{') {
        throw new SyntaxError(`Unexpected character in gh JSON output at position ${index}.`);
      }
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (character === '\\') escape = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) {
        documents.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (start !== -1 || inString) {
    throw new SyntaxError('Incomplete JSON document in gh output.');
  }
  return documents;
};

/**
 * @param {string} value
 * @param {Readonly<Record<string, boolean | number | string>> | undefined} query
 */
const appendQuery = (value, query) => {
  let path = value.startsWith('/') ? value : `/${value}`;
  if (!query) {
    return path;
  }
  const params = new URLSearchParams();
  for (const [key, parameter] of Object.entries(query)) {
    params.set(key, String(parameter));
  }
  const suffix = params.toString();
  if (suffix) {
    path = `${path}${path.includes('?') ? '&' : '?'}${suffix}`;
  }
  return path;
};

/** @param {Readonly<Record<string, boolean | number | string>> | undefined} query */
const withoutPageSize = (query) =>
  query && Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'per_page'));

/**
 * @param {{ repoRoot: string }} options
 */
const createGhGitHubTransport = ({ repoRoot }) => {
  const repositoryIdentity = realpathSync.native(repoRoot);

  /**
   * @param {ReadonlyArray<string>} args
   * @param {unknown} input
   * @param {{maxBytes?: number, sharedKey?: string, signal?: AbortSignal}} options
   */
  const readApiBuffer = async (args, input, options) => {
    const maxBytes = normalizeMaxBytes(options.maxBytes);
    const bytes = options.sharedKey
      ? await readSharedGet(options.sharedKey, maxBytes, ({ getMaxBytes, onOutputLimit }) =>
          runGhApiBuffer(repoRoot, args, input, {
            getMaxBytes,
            onOutputLimit,
            signal: options.signal,
          }),
        )
      : await runGhApiBuffer(repoRoot, args, input, {
          maxBytes,
          signal: options.signal,
        });
    return enforceOutputLimit(bytes, maxBytes);
  };

  /**
   * @param {{maxBytes?: number, query: string, signal?: AbortSignal, variables: Readonly<Record<string, boolean | number | string | null>>}} request
   */
  const graphql = async (request) => {
    /** @type {Array<string>} */
    const args = ['graphql', '-f', `query=${request.query}`];
    for (const [key, value] of Object.entries(request.variables)) {
      if (value != null) {
        args.push('-F', `${key}=${String(value)}`);
      }
    }
    return JSON.parse(
      (
        await readApiBuffer(args, undefined, {
          maxBytes: request.maxBytes,
          signal: request.signal,
        })
      ).toString('utf8'),
    );
  };

  /**
   * @param {{
   *   maxBytes?: number,
   *   method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
   *   path: string,
   *   query?: Readonly<Record<string, boolean | number | string>>,
   *   accept?: string,
   *   body?: unknown,
   *   paginate?: boolean,
   *   signal?: AbortSignal,
   * }} request
   */
  const requestText = async (request) => {
    /** @type {Array<string>} */
    const args = [];
    if (request.paginate) {
      args.push('--paginate');
    }
    if (request.method && request.method !== 'GET') {
      args.push('--method', request.method);
    }
    if (request.accept) {
      args.push('-H', `Accept: ${request.accept}`);
    }
    args.push(appendQuery(request.path, request.query));
    if (request.body != null) {
      args.push('--input', '-');
    }
    const sharedKey =
      request.body == null && (!request.method || request.method === 'GET') && !request.signal
        ? `${repositoryIdentity}\0text\0${request.paginate ? 'paginate' : 'single'}\0${request.accept || ''}\0${appendQuery(request.path, request.paginate ? withoutPageSize(request.query) : request.query)}`
        : undefined;
    return (
      await readApiBuffer(args, request.body, {
        maxBytes: request.maxBytes,
        sharedKey,
        signal: request.signal,
      })
    ).toString('utf8');
  };

  return {
    graphql,
    /**
     * @template T
     * @param {{
     *   maxBytes?: number,
     *   method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
     *   path: string,
     *   query?: Readonly<Record<string, boolean | number | string>>,
     *   body?: unknown,
     *   paginate?: boolean,
     *   signal?: AbortSignal,
     * }} request
     * @returns {Promise<T>}
     */
    async request(request) {
      const text = await requestText(request);
      if (!text.trim()) {
        return /** @type {T} */ (null);
      }
      if (request.paginate) {
        const documents = parseJsonDocuments(text);
        return /** @type {T} */ (
          documents.flatMap((document) => (Array.isArray(document) ? document : [document]))
        );
      }
      return /** @type {T} */ (JSON.parse(text));
    },
    async requestBuffer(request) {
      /** @type {Array<string>} */
      const args = [];
      if (request.accept) {
        args.push('-H', `Accept: ${request.accept}`);
      }
      args.push(appendQuery(request.path, request.query));
      return readApiBuffer(args, undefined, {
        maxBytes: request.maxBytes,
        sharedKey: !request.signal
          ? `${repositoryIdentity}\0buffer\0single\0${request.accept || ''}\0${appendQuery(request.path, request.query)}`
          : undefined,
        signal: request.signal,
      });
    },
    requestText,
  };
};

module.exports = {
  GH_NOT_FOUND_CODE,
  ProviderOutputLimitError,
  appendQuery,
  createGhGitHubTransport,
  createGhNotFoundError,
  getGhCommand,
  parseJsonDocuments,
  runGhApi,
  runGhApiBuffer,
};
