// @ts-check

const { spawn } = require('node:child_process');
const { dirname, extname } = require('node:path');
const { gitOrEmpty, validateRepositoryPath } = require('./git-state/common.cjs');

/** @typedef {import('../core/types.ts').DefinitionCandidate} DefinitionCandidate */
/** @typedef {import('../core/types.ts').DefinitionSearchRequest} DefinitionSearchRequest */
/** @typedef {import('../core/types.ts').DefinitionSearchResult} DefinitionSearchResult */

const MAX_CANDIDATES = 12;
const MAX_MATCHES_PER_FILE = 20;
const MAX_SEARCH_MATCHES = 1000;
const MAX_SEARCH_OUTPUT_BYTES = 256 * 1024;
const SEARCH_TIMEOUT_MS = 1500;
const identifierPattern = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;
const identifierCharacterPattern = /[$\u200C\u200D\p{ID_Continue}]/u;

const extensionGroups = [
  ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'],
  ['.py', '.pyi'],
  ['.go'],
  ['.rs'],
  ['.java', '.kt', '.kts'],
  ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.m', '.mm'],
  ['.cs'],
  ['.rb'],
  ['.swift'],
  ['.php'],
  ['.bash', '.fish', '.sh', '.zsh'],
];

/** @param {string} value */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {string} identifier @param {string} line */
const containsIdentifier = (identifier, line) => {
  let index = line.indexOf(identifier);
  while (index !== -1) {
    const before = index > 0 ? line[index - 1] : '';
    const after = line[index + identifier.length] || '';
    if (
      (!before || !identifierCharacterPattern.test(before)) &&
      (!after || !identifierCharacterPattern.test(after))
    ) {
      return true;
    }
    index = line.indexOf(identifier, index + identifier.length);
  }
  return false;
};

/** @param {string} path */
const getPathspecs = (path) => {
  const extension = extname(path).toLowerCase();
  const group = extensionGroups.find((extensions) => extensions.includes(extension));
  return (group || (extension ? [extension] : [])).map((item) => `*${item}`);
};

/**
 * Deliberately conservative declaration recognition. False negatives fall back
 * to an empty result; false positives would make navigation feel untrustworthy.
 * @param {string} identifier
 * @param {string} path
 * @param {string} line
 * @returns {{kind: string; strength: number} | null}
 */
const classifyDefinition = (identifier, path, line) => {
  const name = escapeRegExp(identifier);
  const extension = extname(path).toLowerCase();
  const matches = (pattern) => new RegExp(pattern, 'u').test(line);
  if (['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'].includes(extension)) {
    if (matches(`\\b(?:async\\s+)?function\\s+${name}\\b`))
      return { kind: 'function', strength: 100 };
    if (matches(`\\bclass\\s+${name}\\b`)) return { kind: 'class', strength: 100 };
    if (matches(`\\binterface\\s+${name}\\b`)) return { kind: 'interface', strength: 100 };
    if (matches(`\\b(?:type|enum|namespace)\\s+${name}\\b`)) return { kind: 'type', strength: 95 };
    if (matches(`\\b(?:const|let|var)\\s+${name}\\b`)) return { kind: 'variable', strength: 85 };
  } else if (['.py', '.pyi'].includes(extension)) {
    if (matches(`^\\s*(?:async\\s+)?def\\s+${name}\\b`)) return { kind: 'function', strength: 100 };
    if (matches(`^\\s*class\\s+${name}\\b`)) return { kind: 'class', strength: 100 };
    if (matches(`^\\s*${name}\\s*(?::[^=]+)?=`)) return { kind: 'variable', strength: 80 };
  } else if (extension === '.go') {
    if (matches(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${name}\\b`))
      return { kind: 'function', strength: 100 };
    if (matches(`^\\s*(?:type|var|const)\\s+${name}\\b`))
      return { kind: 'declaration', strength: 90 };
  } else if (extension === '.rs') {
    if (matches(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\b`))
      return { kind: 'function', strength: 100 };
    if (
      matches(
        `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|type|mod|const|static)\\s+${name}\\b`,
      )
    )
      return { kind: 'declaration', strength: 95 };
    if (matches(`^\\s*macro_rules!\\s+${name}\\b`)) return { kind: 'macro', strength: 100 };
  } else if (['.rb'].includes(extension)) {
    if (matches(`^\\s*def\\s+(?:self\\.)?${name}\\b`)) return { kind: 'method', strength: 100 };
    if (matches(`^\\s*(?:class|module)\\s+${name}\\b`))
      return { kind: 'declaration', strength: 95 };
  } else if (extension === '.swift') {
    if (matches(`^\\s*(?:[\\w@]+\\s+)*func\\s+${name}\\b`))
      return { kind: 'function', strength: 100 };
    if (
      matches(`^\\s*(?:[\\w@]+\\s+)*(?:class|struct|enum|protocol|typealias|let|var)\\s+${name}\\b`)
    )
      return { kind: 'declaration', strength: 90 };
  } else if (['.kt', '.kts'].includes(extension)) {
    if (matches(`^\\s*(?:[\\w@]+\\s+)*fun\\s+${name}\\b`))
      return { kind: 'function', strength: 100 };
    if (matches(`^\\s*(?:[\\w@]+\\s+)*(?:class|interface|object|typealias|val|var)\\s+${name}\\b`))
      return { kind: 'declaration', strength: 90 };
  } else if (extension === '.php') {
    if (matches(`\\bfunction\\s+${name}\\b`)) return { kind: 'function', strength: 100 };
    if (matches(`\\b(?:class|interface|trait|enum)\\s+${name}\\b`))
      return { kind: 'declaration', strength: 95 };
  } else if (['.bash', '.fish', '.sh', '.zsh'].includes(extension)) {
    if (matches(`^\\s*(?:function\\s+)?${name}\\s*\\(\\)`))
      return { kind: 'function', strength: 100 };
  }

  if (
    [
      '.c',
      '.cc',
      '.cpp',
      '.cxx',
      '.cs',
      '.h',
      '.hh',
      '.hpp',
      '.hxx',
      '.java',
      '.m',
      '.mm',
    ].includes(extension)
  ) {
    if (matches(`\\b(?:class|interface|enum|struct|record|typedef)\\s+${name}\\b`))
      return { kind: 'type', strength: 100 };
    if (matches(`^\\s*(?:[\\w:<>,*&?\\[\\]@]+\\s+)+${name}\\s*\\(`))
      return { kind: 'function', strength: 85 };
  }

  return null;
};

/** @param {string} output @param {string | null} revision */
const parseGrepOutput = (output, revision) => {
  /** @type {Array<{line: string; lineNumber: number; path: string}>} */
  const matches = [];
  let cursor = 0;
  while (cursor < output.length) {
    const pathEnd = output.indexOf('\0', cursor);
    const lineEnd = output.indexOf('\0', pathEnd + 1);
    const recordEnd = output.indexOf('\n', lineEnd + 1);
    if (pathEnd === -1 || lineEnd === -1) break;
    let path = output.slice(cursor, pathEnd);
    if (revision && path.startsWith(`${revision}:`)) path = path.slice(revision.length + 1);
    const lineNumber = Number(output.slice(pathEnd + 1, lineEnd));
    const line = output.slice(lineEnd + 1, recordEnd === -1 ? output.length : recordEnd);
    if (path && Number.isFinite(lineNumber)) matches.push({ line, lineNumber, path });
    cursor = recordEnd === -1 ? output.length : recordEnd + 1;
  }
  return matches;
};

const createAbortError = () => {
  const error = new Error('Definition search was cancelled.');
  error.name = 'AbortError';
  return error;
};

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {{maxMatches?: number; maxOutputBytes?: number; signal?: AbortSignal; spawnProcess?: typeof spawn; timeoutMs?: number}} [options]
 * @returns {Promise<string>}
 */
const runBoundedGitGrep = (
  repoPath,
  args,
  {
    maxMatches = MAX_SEARCH_MATCHES,
    maxOutputBytes = MAX_SEARCH_OUTPUT_BYTES,
    signal,
    spawnProcess = spawn,
    timeoutMs = SEARCH_TIMEOUT_MS,
  } = {},
) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child = spawnProcess('git', ['-C', repoPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];
    let matchCount = 0;
    let outputBytes = 0;
    let settled = false;
    /** @type {'aborted' | 'limit' | 'timeout' | null} */
    let stopReason = null;

    /** @param {'aborted' | 'limit' | 'timeout'} reason */
    const stop = (reason) => {
      if (stopReason == null) {
        stopReason = reason;
        child.kill();
      }
    };
    const abort = () => stop('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    child.stdout.on('data', (value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remainingBytes = maxOutputBytes - outputBytes;
      const remainingMatches = maxMatches - matchCount;
      if (remainingBytes <= 0 || remainingMatches <= 0) {
        stop('limit');
        return;
      }

      let allowedLength = Math.min(chunk.length, remainingBytes);
      let chunkMatches = 0;
      for (let index = 0; index < allowedLength; index += 1) {
        if (chunk[index] === 10 && ++chunkMatches === remainingMatches) {
          allowedLength = index + 1;
          break;
        }
      }
      if (allowedLength > 0) {
        const allowed = chunk.subarray(0, allowedLength);
        stdout.push(allowed);
        outputBytes += allowed.length;
        matchCount += chunkMatches;
      }
      if (
        allowedLength < chunk.length ||
        outputBytes >= maxOutputBytes ||
        matchCount >= maxMatches
      ) {
        stop('limit');
      }
    });
    child.stderr.on('data', (value) => {
      if (Buffer.concat(stderr).length < 8192) {
        stderr.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
      }
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stopReason === 'aborted') {
        reject(createAbortError());
      } else if (stopReason === 'timeout') {
        reject(new Error('Definition search timed out.'));
      } else if (code === 0 || code === 1 || stopReason === 'limit') {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(
          new Error(Buffer.concat(stderr).toString('utf8') || `git exited with status ${code}`),
        );
      }
    });
  });

/** @param {DefinitionSearchRequest} request @param {string} repoPath */
const resolveSearchRevision = async (request, repoPath) => {
  const { kind, side, source } = request;
  if (kind === 'staged')
    return side === 'additions'
      ? { cached: true, revision: null }
      : { cached: false, revision: 'HEAD' };
  if (kind === 'unstaged')
    return side === 'additions'
      ? { cached: false, revision: null, untracked: true }
      : { cached: true, revision: null };

  let head = null;
  let base = null;
  let mergeBase = false;
  if (source.type === 'commit') {
    head = source.ref;
    base = `${source.ref}^`;
  } else if (source.type === 'range') {
    head = source.head;
    base = source.base;
    mergeBase = source.symmetric;
  } else if (source.type === 'branch-diff') {
    head = source.headRef;
    base = source.baseRef;
  } else if (source.type === 'branch-working-tree' && source.headRef) {
    head = source.headRef;
    base = source.baseRef || `${source.headRef}^`;
  } else if (source.type === 'branch') {
    head = source.ref;
    base = `${source.ref}^`;
  } else if (source.type === 'pull-request' && source.number != null) {
    const namespace = source.provider === 'gitlab' ? 'merge-requests' : 'pull-requests';
    head = `refs/codiff/${namespace}/${source.number}/head`;
    base = `refs/codiff/${namespace}/${source.number}/base`;
    mergeBase = true;
  }

  if (!head) return { cached: false, revision: null };
  if (side === 'additions') return { cached: false, revision: head };
  if (mergeBase && base) {
    const resolved = (await gitOrEmpty(repoPath, ['merge-base', base, head])).trim();
    return { cached: false, revision: resolved || base };
  }
  return { cached: false, revision: base || `${head}^` };
};

/**
 * @param {string} repoPath
 * @param {DefinitionSearchRequest} request
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<DefinitionSearchResult>}
 */
const findDefinitions = async (repoPath, request, options = {}) => {
  try {
    if (!identifierPattern.test(request.identifier) || request.identifier.length > 256) {
      return { reason: 'Select a valid identifier.', status: 'unavailable' };
    }
    const currentPath = validateRepositoryPath(request.path);
    const pathspecs = getPathspecs(currentPath);
    if (pathspecs.length === 0)
      return { candidates: [], identifier: request.identifier, status: 'ready' };
    const snapshot = await resolveSearchRevision(request, repoPath);
    const args = [
      'grep',
      '--no-recurse-submodules',
      '-n',
      '--null',
      '-I',
      '-F',
      `--max-count=${MAX_MATCHES_PER_FILE}`,
      '-e',
      request.identifier,
    ];
    if (snapshot.cached) args.push('--cached');
    else if (snapshot.untracked) args.push('--untracked');
    if (snapshot.revision) args.push(snapshot.revision);
    args.push('--', ...pathspecs);
    const output = await runBoundedGitGrep(repoPath, args, options);
    const currentDirectory = dirname(currentPath);
    const candidates = parseGrepOutput(output, snapshot.revision)
      .filter((match) => containsIdentifier(request.identifier, match.line))
      .map((match) => {
        const classification = classifyDefinition(request.identifier, match.path, match.line);
        if (!classification) return null;
        const score =
          classification.strength +
          (match.path === currentPath ? 25 : dirname(match.path) === currentDirectory ? 10 : 0);
        return { ...match, kind: classification.kind, score };
      })
      .filter((match) => match != null)
      .sort(
        (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.lineNumber - b.lineNumber,
      );
    const seen = new Set();
    /** @type {Array<DefinitionCandidate>} */
    const unique = [];
    for (const candidate of candidates) {
      const key = `${candidate.path}:${candidate.lineNumber}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push({
          canOpenInEditor: snapshot.revision == null && !snapshot.cached,
          kind: candidate.kind,
          line: candidate.line.trim(),
          lineNumber: candidate.lineNumber,
          path: candidate.path,
          side: request.side,
        });
      }
      if (unique.length === MAX_CANDIDATES) break;
    }
    return { candidates: unique, identifier: request.identifier, status: 'ready' };
  } catch {
    return {
      reason: 'Definition search is unavailable for this repository.',
      status: 'unavailable',
    };
  }
};

/** @param {typeof findDefinitions} [searchDefinitions] */
const createDefinitionSearchCoordinator = (searchDefinitions = findDefinitions) => {
  /** @type {Map<number, AbortController>} */
  const active = new Map();
  return {
    /** @param {number} key */
    cancel: (key) => {
      active.get(key)?.abort();
      active.delete(key);
    },
    /**
     * @param {number} key
     * @param {string} repoPath
     * @param {DefinitionSearchRequest} request
     */
    find: async (key, repoPath, request) => {
      active.get(key)?.abort();
      const controller = new AbortController();
      active.set(key, controller);
      try {
        return await searchDefinitions(repoPath, request, { signal: controller.signal });
      } finally {
        if (active.get(key) === controller) {
          active.delete(key);
        }
      }
    },
  };
};

module.exports = {
  classifyDefinition,
  createDefinitionSearchCoordinator,
  findDefinitions,
  parseGrepOutput,
  runBoundedGitGrep,
};
