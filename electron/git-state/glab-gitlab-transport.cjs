// @ts-check

/**
 * glab-backed GitLabTransport for local Codiff.
 * Keeps executable discovery, process spawning, and credentials in Electron.
 */

const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { findExecutableOnPath, isExecutableFile } = require('../agent-shared.cjs');
const { getCommandEnvironment } = require('../login-shell-environment.cjs');
const { getCurrentCommandSignal } = require('./common.cjs');

const DEFAULT_PROVIDER_OUTPUT_BYTES = 8 * 1024 * 1024;
const GLAB_NOT_FOUND_CODE = 'GLAB_NOT_FOUND';
const GLAB_NOT_FOUND_MESSAGE =
  'GitLab support requires glab. Install glab, authenticate it, and verify `glab --version` works in Terminal. Codiff searches PATH, ~/.local/bin/glab, /opt/homebrew/bin/glab, and /usr/local/bin/glab. If glab is installed somewhere else, launch Codiff with `CODIFF_GLAB_PATH=/absolute/path/to/glab codiff -w`.';
class ProviderOutputLimitError extends Error {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    super(`glab api response exceeded the ${maxBytes}-byte safety limit.`);
    this.name = 'ProviderOutputLimitError';
  }
}

/** @typedef {{errorName?: string, maxBytes?: number, outputLimitExceeded: boolean, promise: Promise<Buffer>, status: 'pending' | 'fulfilled' | 'rejected'}} SharedGetRequest */

const sharedGetRequests = new Map();

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
 * Share only uncancelable GETs, briefly retaining completed bytes so the
 * initial loader and history enrichment can apply their own response bounds
 * to one provider read. Concurrent consumers can raise the acquisition bound
 * until output crosses it; a later consumer with a larger bound starts a new
 * read only when an earlier bounded read has already discarded bytes.
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
    }, 1000);
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
const createGlabNotFoundError = (detail) => {
  const error = /** @type {Error & { code?: string }} */ (
    new Error(detail ? `${GLAB_NOT_FOUND_MESSAGE} ${detail}` : GLAB_NOT_FOUND_MESSAGE)
  );
  error.code = GLAB_NOT_FOUND_CODE;
  return error;
};

const getGlabCommand = () => {
  const glabPath = process.env.CODIFF_GLAB_PATH?.trim();
  if (glabPath) {
    if (isExecutableFile(glabPath)) {
      return glabPath;
    }
    throw createGlabNotFoundError(
      `CODIFF_GLAB_PATH is set to ${JSON.stringify(glabPath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('glab');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.local/bin/glab'),
    '/opt/homebrew/bin/glab',
    '/usr/local/bin/glab',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createGlabNotFoundError();
};

/**
 * @param {string} hostname
 * @param {string} path
 * @param {Readonly<Record<string, boolean | number | string>> | undefined} query
 * @param {string | undefined} method
 * @param {unknown} body
 */
const createGlabApiArgs = (hostname, path, query, method, body) => {
  const url = new URL(path, 'https://gitlab.local');
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }
  const apiPath = url.pathname.replace(/^\/api\/v4(?=\/|$)/, '');
  const resource = `${apiPath || '/'}${url.search}`;
  /** @type {Array<string>} */
  const args = ['api', '--hostname', hostname];
  if (method && method !== 'GET') {
    args.push('--method', method);
  }
  if (body != null) {
    args.push('--header', 'Content-Type: application/json', '--input', '-');
  }
  args.push(resource);
  return args;
};

/**
 * @param {string} repoRoot
 * @param {string} hostname
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 * @param {{getMaxBytes?: () => number | undefined, maxBytes?: number, onOutputLimit?: () => void, signal?: AbortSignal}} [options]
 * @returns {Promise<Buffer>}
 */
const runGlabApiBuffer = async (repoRoot, hostname, args, input, options = {}) => {
  const environment = await getCommandEnvironment();
  return new Promise((resolve, reject) => {
    const fixedMaxBytes = normalizeMaxBytes(options.maxBytes);
    let command;
    try {
      command = getGlabCommand();
    } catch (error) {
      reject(error);
      return;
    }

    const child = spawn(command, args, {
      cwd: repoRoot,
      env: environment,
      signal: options.signal ?? getCurrentCommandSignal(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputLimit;
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
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      reject(
        /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
          ? createGlabNotFoundError()
          : error,
      );
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        if (outputLimit != null) {
          reject(new ProviderOutputLimitError(outputLimit));
        } else {
          resolve(Buffer.concat(stdout, outputBytes));
        }
      } else {
        const error = new Error(
          Buffer.concat(stderr).toString('utf8').trim() || `glab api exited with code ${code}.`,
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
 * @param {string} hostname
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 * @param {{maxBytes?: number, signal?: AbortSignal}} [options]
 */
const runGlabApi = async (repoRoot, hostname, args, input, options = {}) =>
  (await runGlabApiBuffer(repoRoot, hostname, args, input, options)).toString('utf8');

/**
 * @param {{ hostname: string, repoRoot: string, signal?: AbortSignal }} options
 */
const createGlabGitLabTransport = ({ hostname, repoRoot, signal: defaultSignal }) => {
  /**
   * @param {ReadonlyArray<string>} args
   * @param {unknown} input
   * @param {{maxBytes?: number, sharedKey?: string, signal?: AbortSignal}} options
   */
  const readApiBuffer = async (args, input, options) => {
    const maxBytes = normalizeMaxBytes(options.maxBytes);
    const signal = options.signal ?? getCurrentCommandSignal();
    const bytes = options.sharedKey
      ? await readSharedGet(options.sharedKey, maxBytes, ({ getMaxBytes, onOutputLimit }) =>
          runGlabApiBuffer(repoRoot, hostname, args, input, {
            getMaxBytes,
            onOutputLimit,
            signal,
          }),
        )
      : await runGlabApiBuffer(repoRoot, hostname, args, input, {
          maxBytes,
          signal,
        });
    return enforceOutputLimit(bytes, maxBytes);
  };

  /**
   * @param {{
   *   maxBytes?: number,
   *   method?: 'GET' | 'POST' | 'PUT' | 'DELETE',
   *   path: string,
   *   query?: Readonly<Record<string, boolean | number | string>>,
   *   body?: unknown,
   *   signal?: AbortSignal,
   * }} request
   */
  const requestText = async (request) => {
    const args = createGlabApiArgs(
      hostname,
      request.path,
      request.query,
      request.method,
      request.body,
    );
    const signal = request.signal || defaultSignal || getCurrentCommandSignal();
    const sharedKey =
      request.body == null && (!request.method || request.method === 'GET') && !signal
        ? `${repoRoot}\0${hostname}\0text\0${args.join('\0')}`
        : undefined;
    return (
      await readApiBuffer(args, request.body, {
        maxBytes: request.maxBytes,
        sharedKey,
        signal,
      })
    ).toString('utf8');
  };

  /**
   * glab writes each JSON page consecutively when `--paginate` is used. Parse
   * the stream as JSON values instead of assuming a particular separator.
   * @param {string} text
   * @returns {Array<unknown>}
   */
  const parseJsonPages = (text) => {
    /** @type {Array<unknown>} */
    const pages = [];
    let depth = 0;
    let escape = false;
    let inString = false;
    let start = -1;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (start === -1) {
        if (/\s/.test(character)) {
          continue;
        }
        if (character !== '[' && character !== '{') {
          throw new SyntaxError(`Unexpected character in glab JSON output at position ${index}.`);
        }
        start = index;
        depth = 1;
        continue;
      }

      if (inString) {
        if (escape) {
          escape = false;
        } else if (character === '\\') {
          escape = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === '[' || character === '{') {
        depth += 1;
      } else if (character === ']' || character === '}') {
        depth -= 1;
        if (depth === 0) {
          pages.push(JSON.parse(text.slice(start, index + 1)));
          start = -1;
        }
      }
    }

    if (start !== -1 || inString) {
      throw new SyntaxError('Incomplete JSON document in glab output.');
    }
    return pages;
  };

  return {
    /**
     * @template T
     * @param {{
     *   maxBytes?: number,
     *   method?: 'GET' | 'POST' | 'PUT' | 'DELETE',
     *   path: string,
     *   query?: Readonly<Record<string, boolean | number | string>>,
     *   body?: unknown,
     *   signal?: AbortSignal,
     * }} request
     * @returns {Promise<T>}
     */
    async request(request) {
      const text = await requestText(request);
      if (!text.trim()) {
        return /** @type {T} */ (null);
      }
      return /** @type {T} */ (JSON.parse(text));
    },
    async requestBuffer(request) {
      const args = createGlabApiArgs(hostname, request.path, request.query, undefined, undefined);
      const signal = request.signal || defaultSignal || getCurrentCommandSignal();
      return readApiBuffer(args, undefined, {
        maxBytes: request.maxBytes,
        sharedKey: !signal ? `${repoRoot}\0${hostname}\0buffer\0${args.join('\0')}` : undefined,
        signal,
      });
    },
    async requestPages(request) {
      const args = createGlabApiArgs(hostname, request.path, request.query, undefined, undefined);
      args.splice(-1, 0, '--paginate');
      const signal = request.signal || defaultSignal || getCurrentCommandSignal();
      const pages = parseJsonPages(
        (
          await readApiBuffer(args, undefined, {
            maxBytes: request.maxBytes,
            sharedKey: !signal ? `${repoRoot}\0${hostname}\0${args.join('\0')}` : undefined,
            signal,
          })
        ).toString('utf8'),
      );
      return pages.flatMap((page) => {
        if (!Array.isArray(page)) {
          throw new Error('glab returned a non-array paginated response.');
        }
        return page;
      });
    },
    requestText,
  };
};

module.exports = {
  GLAB_NOT_FOUND_CODE,
  ProviderOutputLimitError,
  createGlabGitLabTransport,
  createGlabNotFoundError,
  getGlabCommand,
  runGlabApi,
  runGlabApiBuffer,
};
