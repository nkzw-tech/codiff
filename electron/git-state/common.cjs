// @ts-check

const { AsyncLocalStorage } = require('node:async_hooks');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { promises: fs } = require('node:fs');
const { createHash } = require('node:crypto');
const { isAbsolute, join, normalize, sep } = require('node:path');
const { promisify } = require('node:util');
const { getCommandActionSignal, startCommandTiming } = require('../command-log.cjs');

const execFileAsync = promisify(execFile);
const commandSignalStorage = new AsyncLocalStorage();
const getCurrentCommandSignal = () => commandSignalStorage.getStore();
/** @template Value @param {AbortSignal} signal @param {() => Value} callback */
const runWithCommandSignal = (signal, callback) => commandSignalStorage.run(signal, callback);

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffSection} DiffSection
 * @typedef {import('../../core/types.ts').GitFileStatus} GitFileStatus
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/types.ts').SubmitPullRequestCommentRequest} SubmitPullRequestCommentRequest
 * @typedef {import('../../core/types.ts').SubmitPullRequestReviewRequest} SubmitPullRequestReviewRequest
 * @typedef {'staged' | 'unstaged'} WorkingTreeSectionKind
 * @typedef {{cacheKey: string; contents: string; name: string}} TextFile
 * @typedef {{reason: string; canLoad?: boolean; fileCount?: number; fingerprint?: string; limit?: number; loadState?: DiffSection['loadState']; size?: number}} DiffSummary
 * @typedef {{binary: boolean; file?: TextFile; fingerprint?: string; loadState?: DiffSection['loadState']; summary?: DiffSummary}} FileContentResult
 * @typedef {{
 *   conflictStage?: 1 | 2 | 3;
 *   directory?: boolean;
 *   oldPath?: string;
 *   path: string;
 *   staged: boolean;
 *   status: GitFileStatus;
 *   summary?: DiffSummary;
 *   unstaged: boolean;
 *   untracked: boolean;
 * }} StatusItem
 * @typedef {{force?: boolean; head?: string; patch?: {binary: boolean; patch: string}; patchOnly?: boolean; showWhitespace?: boolean}} ReadFileOptions
 * @typedef {{number: number; owner: string; repo: string; url: string}} PullRequestReference
 * @typedef {{owner: string; repo: string}} GitHubRemote
 * @typedef {{filename: string; patch?: string; previous_filename?: string; status: string}} GitHubPullRequestFile
 * @typedef {{head?: {sha?: string}; title?: string}} GitHubPullRequestMetadata
 * @typedef {{[key: string]: any}} GitHubReviewComment
 */

/** @param {string | Buffer} value */
const getFingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** @param {string} email */
const getGravatarHash = (email) =>
  createHash('md5').update(email.trim().toLowerCase()).digest('hex');

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {{encoding?: BufferEncoding, signal?: AbortSignal}} [options]
 * @returns {Promise<string>}
 */
const git = async (repoPath, args, options = {}) => {
  const commandArgs = ['-C', repoPath, ...args];
  const signal = options.signal || getCurrentCommandSignal() || getCommandActionSignal();
  const timing = startCommandTiming({ args: commandArgs, command: 'git', cwd: repoPath });
  try {
    const { stdout } = await execFileAsync('git', commandArgs, {
      encoding: options.encoding || 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      signal,
    });
    timing.finish();
    return stdout;
  } catch (error) {
    timing.finish({ canceled: error instanceof Error && error.name === 'AbortError', error });
    throw error;
  }
};

/** @param {string} repoPath @param {ReadonlyArray<string>} args @param {{signal?: AbortSignal}} [options] @returns {Promise<Buffer>} */
const gitBuffer = async (repoPath, args, options = {}) => {
  const commandArgs = ['-C', repoPath, ...args];
  const signal = options.signal || getCurrentCommandSignal() || getCommandActionSignal();
  const timing = startCommandTiming({ args: commandArgs, command: 'git', cwd: repoPath });
  try {
    const { stdout } = await execFileAsync('git', commandArgs, {
      encoding: 'buffer',
      maxBuffer: 1024 * 1024 * 64,
      signal,
    });
    timing.finish();
    return stdout;
  } catch (error) {
    timing.finish({ canceled: error instanceof Error && error.name === 'AbortError', error });
    throw error;
  }
};

/**
 * Canonical synchronous Git boundary for startup paths that must resolve
 * before a window exists.
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {{encoding?: BufferEncoding}} [options]
 */
const gitSync = (repoPath, args, options = {}) => {
  (getCurrentCommandSignal() || getCommandActionSignal())?.throwIfAborted();
  const commandArgs = ['-C', repoPath, ...args];
  const timing = startCommandTiming({ args: commandArgs, command: 'git', cwd: repoPath });
  try {
    const output = execFileSync('git', commandArgs, {
      encoding: options.encoding || 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    timing.finish({ exitCode: 0 });
    return output;
  } catch (error) {
    timing.finish({
      error,
      exitCode:
        error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
          ? error.status
          : null,
    });
    throw error;
  }
};

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {string | Buffer} input
 * @param {{env?: NodeJS.ProcessEnv, signal?: AbortSignal}} [options]
 * @returns {Promise<Buffer>}
 */
const gitBufferWithInput = (repoPath, args, input, options = {}) =>
  new Promise((resolve, reject) => {
    const commandArgs = ['-C', repoPath, ...args];
    const signal = options.signal || getCurrentCommandSignal() || getCommandActionSignal();
    const timing = startCommandTiming({ args: commandArgs, command: 'git', cwd: repoPath });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];
    let settled = false;

    /** @param {unknown} reason @param {{canceled?: boolean, exitCode?: number | null, signal?: string | null}} [result] */
    const fail = (reason, result = {}) => {
      if (settled) return;
      settled = true;
      const error = reason instanceof Error ? reason : new Error(String(reason));
      timing.finish({ ...result, error });
      reject(error);
    };

    const abortError = () => {
      const reason = signal?.reason;
      if (reason instanceof Error) return reason;
      const error = new Error('Git command was aborted.');
      error.name = 'AbortError';
      return error;
    };

    let child;
    try {
      signal?.throwIfAborted();
      child = spawn('git', commandArgs, {
        env: options.env,
        signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      fail(error, { canceled: signal?.aborted });
      return;
    }

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => {
      if (!settled && /** @type {NodeJS.ErrnoException} */ (error).code !== 'EPIPE') {
        fail(error, { canceled: signal?.aborted });
        child.kill();
      }
    });
    child.on('error', (error) =>
      fail(error, { canceled: error.name === 'AbortError' || signal?.aborted }),
    );
    child.on('close', (code, childSignal) => {
      if (settled) return;
      if (signal?.aborted) {
        fail(abortError(), { canceled: true, exitCode: code, signal: childSignal });
        return;
      }
      if (code === 0) {
        settled = true;
        timing.finish({ exitCode: code });
        resolve(Buffer.concat(stdout));
      } else {
        const error = new Error(
          Buffer.concat(stderr).toString('utf8') || `git exited with status ${code}`,
        );
        fail(error, { exitCode: code, signal: childSignal });
      }
    });

    try {
      child.stdin.end(input);
    } catch (error) {
      fail(error, { canceled: signal?.aborted });
      child.kill();
    }
  });

const EAGER_TEXT_FILE_LIMIT = 1024 * 1024;
const MANUAL_TEXT_FILE_LIMIT = 2 * 1024 * 1024;
const MAX_UNTRACKED_INITIAL_ITEMS = 1000;
const GENERATED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.next',
  '.parcel-cache',
  '.pnpm-store',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const generatedDirectoryPathspecExcludes = [...GENERATED_DIRECTORY_NAMES].flatMap((name) => [
  `:(exclude)${name}/**`,
  `:(exclude)**/${name}/**`,
]);

const generatedDirectoryPathspecs = [...GENERATED_DIRECTORY_NAMES].flatMap((name) => [
  name,
  `:(glob)**/${name}/`,
]);

/** @param {{path: string}} left @param {{path: string}} right */
const fileSort = (left, right) => {
  const leftParts = left.path.split('/');
  const rightParts = right.path.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === rightPart) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return leftPart.localeCompare(rightPart);
  }

  return leftParts.length - rightParts.length;
};

/** @param {string} raw @returns {Array<StatusItem>} */
const parseStatus = (raw) => {
  const parts = raw.split('\0').filter(Boolean);
  const files = new Map();

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    const x = record[0];
    const y = record[1];
    let path = record.slice(3);
    /** @type {string | undefined} */
    let oldPath;

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = parts[++index];
    }

    const current = files.get(path) || {
      oldPath,
      path,
      staged: false,
      status: 'modified',
      unstaged: false,
      untracked: false,
    };

    if (x === '?' && y === '?') {
      current.status = 'untracked';
      current.unstaged = true;
      current.untracked = true;
    } else if (['AA', 'AU', 'DD', 'DU', 'UA', 'UD', 'UU'].includes(`${x}${y}`)) {
      const conflictCode = `${x}${y}`;
      if (conflictCode === 'DD') {
        current.conflictStage = 1;
      } else if (conflictCode !== 'DU' && conflictCode !== 'UA') {
        current.conflictStage = 2;
      }
      current.staged = false;
      current.status = 'conflicted';
      current.unstaged = true;
    } else {
      current.staged = x !== ' ';
      current.unstaged = y !== ' ';

      const statusCode = current.staged ? x : y;
      current.status =
        statusCode === 'A'
          ? 'added'
          : statusCode === 'D'
            ? 'deleted'
            : statusCode === 'R' || statusCode === 'C'
              ? 'renamed'
              : 'modified';
    }

    files.set(path, current);
  }

  return [...files.values()].sort(fileSort);
};

/** @param {Buffer} buffer */
const isBinaryBuffer = (buffer) => buffer.includes(0);

/** @param {number} size */
const formatBytes = (size) => {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }

  return `${size} B`;
};

/** @param {string} reason @param {Partial<DiffSummary>} [details] @returns {DiffSummary} */
const createSummary = (reason, details = {}) => ({
  reason,
  ...details,
});

/** @param {unknown} path */
const validateRepositoryPath = (path) => {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path)) {
    throw new Error('Invalid repository path.');
  }

  if (path.split(/[\\/]+/u).includes('..')) {
    throw new Error('Invalid repository path.');
  }

  const normalized = normalize(path);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error('Invalid repository path.');
  }

  return normalized;
};

/** @param {string} repoRoot @param {string} path */
const readFileStat = async (repoRoot, path) => {
  try {
    return await fs.lstat(join(repoRoot, path));
  } catch {
    return undefined;
  }
};

/** @param {string} repoRoot @param {string} spec */
const getBlobSize = async (repoRoot, spec) => {
  try {
    return Number((await git(repoRoot, ['cat-file', '-s', spec])).trim());
  } catch {
    return undefined;
  }
};

/** @param {string} name @param {Buffer} buffer @param {string} cacheKey @returns {FileContentResult} */
const bufferToTextFile = (name, buffer, cacheKey) => {
  const fingerprint = getFingerprint(buffer);

  if (isBinaryBuffer(buffer)) {
    return {
      binary: true,
      fingerprint,
      file: undefined,
      summary: createSummary('Binary file changed.', {
        canLoad: false,
        fingerprint,
        size: buffer.length,
      }),
    };
  }

  return {
    binary: false,
    file: {
      cacheKey,
      contents: buffer.toString('utf8'),
      name,
    },
  };
};

/**
 * @param {string} repoRoot
 * @param {string} ref
 * @param {string} path
 * @param {ReadFileOptions} [options]
 * @returns {Promise<FileContentResult>}
 */
const readGitFile = async (repoRoot, ref, path, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  const spec = `${ref}:${path}`;

  try {
    const size = await getBlobSize(repoRoot, spec);
    if (size != null && size > limit) {
      return {
        binary: false,
        loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(size)} and will be loaded on demand.`,
          {
            canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size,
          },
        ),
      };
    }

    const buffer = await gitBuffer(repoRoot, ['show', spec]);
    return bufferToTextFile(path, buffer, `${ref}:${path}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `${ref}:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

/**
 * @param {string} repoRoot
 * @param {string} path
 * @param {ReadFileOptions} [options]
 * @param {1 | 2 | 3} [stage]
 * @returns {Promise<FileContentResult>}
 */
const readIndexFile = async (repoRoot, path, options = {}, stage) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  const spec = stage ? `:${stage}:${path}` : `:${path}`;

  try {
    const size = await getBlobSize(repoRoot, spec);
    if (size != null && size > limit) {
      return {
        binary: false,
        loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(size)} and will be loaded on demand.`,
          {
            canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size,
          },
        ),
      };
    }

    const buffer = await gitBuffer(repoRoot, ['show', spec]);
    return bufferToTextFile(path, buffer, `index:${path}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `index:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

/**
 * @param {string} repoRoot
 * @param {string} path
 * @param {ReadFileOptions} [options]
 * @returns {Promise<FileContentResult>}
 */
const readWorkingTreeFile = async (repoRoot, path, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;

  try {
    const stat = await readFileStat(repoRoot, path);
    if (!stat) {
      throw new Error('File is missing.');
    }

    if (stat.isDirectory()) {
      return {
        binary: false,
        loadState: 'directory',
        summary: createSummary('Untracked directory is collapsed by default.', {
          canLoad: false,
        }),
      };
    }

    if (stat.isSymbolicLink()) {
      const contents = await fs.readlink(join(repoRoot, path));
      const size = Buffer.byteLength(contents);

      if (size > limit) {
        return {
          binary: false,
          loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
          summary: createSummary(
            size > MANUAL_TEXT_FILE_LIMIT
              ? `Symlink target is ${formatBytes(size)}, so Codiff skipped rendering it.`
              : `Symlink target is ${formatBytes(size)} and will be loaded on demand.`,
            {
              canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
              limit,
              size,
            },
          ),
        };
      }

      return {
        binary: false,
        file: {
          cacheKey: `worktree:${path}:symlink:${contents}`,
          contents,
          name: path,
        },
      };
    }

    if (!stat.isFile()) {
      return {
        binary: false,
        loadState: 'error',
        summary: createSummary('Path is not a regular file.', {
          canLoad: false,
          size: stat.size,
        }),
      };
    }

    if (stat.size > limit) {
      return {
        binary: false,
        loadState: stat.size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          stat.size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(stat.size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(stat.size)} and will be loaded on demand.`,
          {
            canLoad: stat.size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size: stat.size,
          },
        ),
      };
    }

    const buffer = await fs.readFile(join(repoRoot, path));
    return bufferToTextFile(path, buffer, `worktree:${path}:${buffer.length}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `worktree:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

/** @param {string} path @param {string} contents */
const createPatchForNewFile = (path, contents) => {
  const trimmed = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  const lines = trimmed.length > 0 ? trimmed.split('\n') : [];
  const body = lines.map((line) => `+${line}`).join('\n');
  const noNewline = contents.endsWith('\n') ? '' : '\n\\ No newline at end of file';

  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ]
    .filter(Boolean)
    .join('\n')
    .concat(noNewline, '\n');
};

/** @param {{showWhitespace?: boolean}} [options] @returns {Array<string>} */
const getWhitespaceDiffArgs = (options = {}) =>
  options.showWhitespace === false ? ['--ignore-all-space'] : [];

/** @param {string} repoRoot @param {StatusItem} item @param {WorkingTreeSectionKind} kind @param {{head?: string; showWhitespace?: boolean}} [options] */
const getPatch = async (repoRoot, item, kind, options = {}) => {
  const whitespaceArgs = getWhitespaceDiffArgs(options);
  if (item.status === 'conflicted' && !item.conflictStage) {
    const newFile = await readWorkingTreeFile(repoRoot, item.path, options);
    return {
      binary: newFile.binary,
      patch: newFile.file ? createPatchForNewFile(item.path, newFile.file.contents) : '',
    };
  }
  const args =
    item.status === 'conflicted'
      ? [
          'diff',
          item.conflictStage === 1 ? '--base' : item.conflictStage === 3 ? '--theirs' : '--ours',
          '--patch',
          '--no-ext-diff',
          ...whitespaceArgs,
          '--',
          item.path,
        ]
      : kind === 'staged'
        ? [
            'diff',
            '--cached',
            '--patch',
            '--no-ext-diff',
            ...whitespaceArgs,
            ...(options.head ? [options.head] : []),
            '--',
            ...(item.oldPath ? [item.oldPath] : []),
            item.path,
          ]
        : ['diff', '--patch', '--no-ext-diff', ...whitespaceArgs, '--', item.path];
  const rawPatch = await git(repoRoot, args);
  const diffStart = item.status === 'conflicted' ? rawPatch.indexOf('diff --git ') : -1;
  const patch =
    item.status !== 'conflicted' ? rawPatch : diffStart === -1 ? '' : rawPatch.slice(diffStart);

  return {
    binary: /Binary files .* differ/.test(patch),
    patch,
  };
};

/** @param {...FileContentResult} results @returns {{binary: boolean; loadState: DiffSection['loadState']; summary?: DiffSummary}} */
const summarizeContent = (...results) => {
  const binaryResults = results.filter((result) => result.binary);
  if (binaryResults.length > 0) {
    const fingerprint = getFingerprint(
      binaryResults
        .map((result) => `${result.fingerprint || ''}\0${result.summary?.size || ''}`)
        .join('\0'),
    );

    return {
      binary: true,
      loadState: 'binary',
      summary: createSummary('Binary file changed.', {
        canLoad: false,
        fingerprint,
      }),
    };
  }

  const summaryResult = results.find((result) => result.loadState && result.loadState !== 'ready');
  if (summaryResult) {
    return {
      binary: false,
      loadState: summaryResult.loadState,
      summary: summaryResult.summary,
    };
  }

  return {
    binary: false,
    loadState: 'ready',
  };
};

/**
 * @param {string} repoRoot
 * @param {StatusItem} item
 * @param {WorkingTreeSectionKind} kind
 * @param {ReadFileOptions} [options]
 */
const getWorkingTreeContents = async (repoRoot, item, kind, options = {}) => {
  if (kind === 'staged') {
    const oldFile = await readGitFile(
      repoRoot,
      options.head || 'HEAD',
      item.oldPath || item.path,
      options,
    );
    const newFile = await readIndexFile(repoRoot, item.path, options);
    const summary = summarizeContent(oldFile, newFile);

    return {
      ...summary,
      newFile: newFile.file,
      oldFile: oldFile.file,
    };
  }

  if (item.untracked) {
    /** @type {FileContentResult} */
    const newFile = item.summary
      ? {
          binary: false,
          loadState: item.summary.loadState,
          summary: item.summary,
        }
      : item.directory
        ? {
            binary: false,
            loadState: 'directory',
            summary: createSummary('Untracked directory is collapsed by default.', {
              canLoad: false,
            }),
          }
        : await readWorkingTreeFile(repoRoot, item.path, options);
    const summary = summarizeContent(newFile);

    return {
      ...summary,
      newFile: newFile.file,
      oldFile: {
        cacheKey: `empty:${item.path}`,
        contents: '',
        name: item.path,
      },
    };
  }

  const oldFile = await readIndexFile(repoRoot, item.path, options, item.conflictStage);
  const newFile = await readWorkingTreeFile(repoRoot, item.path, options);
  const summary = summarizeContent(oldFile, newFile);

  return {
    ...summary,
    newFile: newFile.file,
    oldFile: oldFile.file,
  };
};

/**
 * @param {string} repoRoot
 * @param {StatusItem} item
 * @param {WorkingTreeSectionKind} kind
 * @param {ReadFileOptions} [options]
 * @returns {Promise<DiffSection>}
 */
const createSection = async (repoRoot, item, kind, options = {}) => {
  const id = `${item.path}:${kind}`;
  const needsWorkingTreeBaseline = item.status === 'conflicted' && !item.conflictStage;
  const head =
    options.head ??
    (kind === 'staged'
      ? (await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim()
      : '');
  const index = {
    kind: 'index',
    label: { kind: 'review-marker', text: 'Index' },
    ...(kind === 'unstaged' && item.conflictStage ? { stage: item.conflictStage } : {}),
  };
  const workingCopy = {
    kind: 'working-copy',
    label: { kind: 'review-marker', text: 'Working copy' },
  };
  const range =
    kind === 'staged'
      ? {
          base: head
            ? {
                label: { kind: 'commit', text: head.slice(0, 7) },
                sha: head,
              }
            : null,
          head: index,
        }
      : { base: index, head: workingCopy };

  if (options.patchOnly && !item.untracked && !needsWorkingTreeBaseline) {
    const patch = options.patch ?? (await getPatch(repoRoot, item, kind, options));

    if (patch.binary) {
      return {
        binary: true,
        id,
        kind,
        loadState: 'binary',
        patch: '',
        range,
        summary: createSummary('Binary file changed.', {
          canLoad: false,
        }),
      };
    }

    return {
      binary: false,
      id,
      kind,
      loadState: 'ready',
      patch: patch.patch,
      range,
    };
  }

  const contents = await getWorkingTreeContents(repoRoot, item, kind, options);

  if (contents.loadState !== 'ready') {
    return {
      binary: contents.binary,
      id,
      kind,
      loadState: contents.loadState,
      patch: '',
      range,
      summary: contents.summary,
    };
  }

  if (item.untracked) {
    return {
      binary: false,
      id,
      kind,
      loadState: 'ready',
      newFile: contents.newFile,
      oldFile: contents.oldFile,
      patch: createPatchForNewFile(item.path, contents.newFile?.contents || ''),
      range,
    };
  }

  const patch = await getPatch(repoRoot, item, kind, options);

  return {
    binary: patch.binary || contents.binary,
    id,
    kind,
    loadState: 'ready',
    newFile: contents.newFile,
    oldFile: contents.oldFile,
    patch: patch.patch,
    range,
  };
};

/** @param {string} statusCode @returns {GitFileStatus} */
const normalizeStatus = (statusCode) =>
  statusCode === 'A'
    ? 'added'
    : statusCode === 'D'
      ? 'deleted'
      : statusCode === 'R' || statusCode === 'C'
        ? 'renamed'
        : 'modified';

/** @param {string} repoRoot @param {ReadonlyArray<string>} args @param {{signal?: AbortSignal}} [options] */
const gitOrEmpty = async (repoRoot, args, options = {}) => {
  const signal = options.signal || getCurrentCommandSignal() || getCommandActionSignal();
  try {
    return await git(repoRoot, args, { ...options, signal });
  } catch {
    signal?.throwIfAborted();
    return '';
  }
};

module.exports = {
  EAGER_TEXT_FILE_LIMIT,
  MANUAL_TEXT_FILE_LIMIT,
  MAX_UNTRACKED_INITIAL_ITEMS,
  bufferToTextFile,
  createSection,
  createSummary,
  fileSort,
  formatBytes,
  generatedDirectoryPathspecExcludes,
  generatedDirectoryPathspecs,
  getCurrentCommandSignal,
  getFingerprint,
  getGravatarHash,
  getWhitespaceDiffArgs,
  git,
  gitBufferWithInput,
  gitOrEmpty,
  gitSync,
  normalizeStatus,
  parseStatus,
  readFileStat,
  readGitFile,
  runWithCommandSignal,
  summarizeContent,
  validateRepositoryPath,
};
