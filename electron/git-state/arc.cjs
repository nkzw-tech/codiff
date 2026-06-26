// @ts-check

const { execFile } = require('node:child_process');
const { lstat, readFile, readlink } = require('node:fs/promises');
const { join } = require('node:path');
const { promisify } = require('node:util');
const {
  bufferToTextFile,
  bufferToImageRevision,
  createSummary,
  createPatchForNewFile,
  fileSort,
  getFingerprint,
  getWhitespaceDiffArgs,
  normalizeStatus,
  readWorkingTreeImageFile,
  validateRepositoryPath,
} = require('./common.cjs');

const execFileAsync = promisify(execFile);
const ansiPattern = /\u001b\[[0-9;]*m/g;

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').CommitMetadata} CommitMetadata
 * @typedef {import('../../core/types.ts').CommitMetadataFile} CommitMetadataFile
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').DiffSection} DiffSection
 * @typedef {import('../../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../../core/types.ts').PullRequestExistingReviewComment} PullRequestExistingReviewComment
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').RepositoryHistory} RepositoryHistory
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/types.ts').SubmitPullRequestCommentRequest} SubmitPullRequestCommentRequest
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 */

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @returns {Promise<string>}
 */
const arc = async (repoPath, args) => {
  try {
    const { stdout } = await execFileAsync('arc', args, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
    });
    return stdout.replace(ansiPattern, '');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Arc support requires the `arc` command to be available on PATH.');
    }
    throw error;
  }
};

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @returns {Promise<Buffer>}
 */
const arcBuffer = async (repoPath, args) => {
  try {
    const { stdout } = await execFileAsync('arc', args, {
      cwd: repoPath,
      maxBuffer: 1024 * 1024 * 64,
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Arc support requires the `arc` command to be available on PATH.');
    }
    throw error;
  }
};

/**
 * @param {string} repoPath
 * @param {string} tool
 * @param {Record<string, unknown>} args
 */
const arcanum = async (repoPath, tool, args) => {
  const toolArgs = ['tool', 'mcp', 'connect', 'devtools', '--tool', tool, '--raw'];
  for (const [key, value] of Object.entries(args)) {
    if (value == null) {
      continue;
    }
    toolArgs.push('--arg', `${key}:${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }

  try {
    const { stdout } = await execFileAsync('ya', toolArgs, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
    });
    return stdout.replace(ansiPattern, '');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'Arcadia pull request comments require `ya tool mcp connect devtools` to be available on PATH.',
      );
    }
    throw error;
  }
};

/** @param {string} raw */
const parseMcpToolPayloads = (raw) => {
  const parsed = JSON.parse(raw);
  const content = parsed?.result?.content;
  if (parsed?.result?.isError) {
    const message = Array.isArray(content)
      ? content
          .map((item) => (typeof item?.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n')
      : '';
    throw new Error(message || 'Arcanum returned an error.');
  }

  return Array.isArray(content)
    ? content
        .map((item) => {
          if (typeof item?.text !== 'string') {
            return null;
          }
          try {
            return JSON.parse(item.text);
          } catch {
            return item.text;
          }
        })
        .filter((item) => item != null)
    : [];
};

/** @param {string} launchPath */
const readArcRoot = async (launchPath) => {
  try {
    return (await arc(launchPath, ['root'])).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Codiff was opened outside an Arc repository: ${detail}`);
  }
};

/** @param {string} repoRoot */
const readArcBranchName = async (repoRoot) => {
  try {
    const output = await arc(repoRoot, ['branch']);
    const current = output
      .split('\n')
      .map((line) => line.trimEnd())
      .find((line) => line.startsWith('* '));
    return current ? current.slice(2).trim() || null : null;
  } catch {
    return null;
  }
};

/** @param {string} raw @returns {Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} */
const normalizeArcStatus = (statusCode) =>
  statusCode === '?' || statusCode === '??' ? 'untracked' : normalizeStatus(statusCode[0] || 'M');

/** @param {string} raw @returns {Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} */
const parseArcNameStatus = (raw) =>
  raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/);
      const statusCode = parts[0] || 'M';
      const statusType = statusCode[0] || 'M';
      if ((statusType === 'R' || statusType === 'C') && parts.length >= 3) {
        return {
          oldPath: parts[1],
          path: parts[2],
          status: normalizeArcStatus(statusType),
        };
      }

      return {
        path: parts.slice(1).join(line.includes('\t') ? '\t' : ' '),
        status: normalizeArcStatus(statusCode),
      };
    })
    .filter((item) => item.path)
    .sort(fileSort);

/**
 * @param {string} repoRoot
 * @param {string} path
 */
const readArcWorkingTreePathSignature = async (repoRoot, path) => {
  try {
    const absolutePath = join(repoRoot, path);
    const stat = await lstat(absolutePath);

    if (stat.isDirectory()) {
      return `${path}\0directory\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}`;
    }

    if (stat.isSymbolicLink()) {
      return `${path}\0symlink\0${stat.mode}\0${await readlink(absolutePath)}`;
    }

    if (!stat.isFile()) {
      return `${path}\0other\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}`;
    }

    const content =
      stat.size <= 64 * 1024 * 1024
        ? getFingerprint(await readFile(absolutePath))
        : `${stat.size}\0${stat.mtimeMs}`;

    return `${path}\0file\0${stat.mode}\0${stat.size}\0${content}`;
  } catch {
    return `${path}\0missing`;
  }
};

/** @param {string} repoRoot @param {Iterable<string>} [additionalPaths] */
const readArcWorkingTreeChangeSignatures = async (repoRoot, additionalPaths = []) => {
  const status = parseArcNameStatus(await arc(repoRoot, ['status', '--short', '-u', 'all']));
  const signatures = new Map();

  for (const item of status) {
    if (item.oldPath && item.oldPath !== item.path) {
      try {
        await lstat(join(repoRoot, item.oldPath));
      } catch {
        signatures.set(item.oldPath, `${item.oldPath}\0missing`);
      }
    }

    signatures.set(item.path, await readArcWorkingTreePathSignature(repoRoot, item.path));
  }
  for (const path of additionalPaths) {
    if (!signatures.has(path)) {
      signatures.set(path, await readArcWorkingTreePathSignature(repoRoot, path));
    }
  }

  return [...signatures.entries()].sort(([left], [right]) => left.localeCompare(right));
};

/** @param {string} patch */
const splitGitPatch = (patch) =>
  patch
    .split(/(?=^diff --git )/m)
    .map((part) => part.trimEnd())
    .filter((part) => part.startsWith('diff --git '))
    .map((part) => `${part}\n`);

/** @param {string} path */
const unquoteDiffPath = (path) => path.replace(/^"|"$/g, '');

/** @param {string} path */
const escapeRegExp = (path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {ReadonlyArray<string>} patches
 * @param {Pick<StatusItem, 'oldPath' | 'path'>} item
 */
const findPatchForItem = (patches, item) => {
  const pathPattern = escapeRegExp(item.path);
  const oldPathPattern = item.oldPath ? escapeRegExp(item.oldPath) : pathPattern;
  const headerPattern = new RegExp(
    `^diff --git "?a/${oldPathPattern}"? "?b/${pathPattern}"?(?:\\n|$)`,
  );
  return patches.find((patch) => headerPattern.test(patch)) || '';
};

/** @param {string} patch */
const parseArcPatchStatus = (patch) =>
  splitGitPatch(patch)
    .map((part) => {
      const header = part.match(/^diff --git ("?a\/.+?"?) ("?b\/.+?"?)(?:\n|$)/);
      if (!header) {
        return null;
      }
      const oldPath = unquoteDiffPath(header[1]).replace(/^a\//, '');
      const path = unquoteDiffPath(header[2]).replace(/^b\//, '');
      return {
        ...(oldPath !== path ? { oldPath } : {}),
        path,
        status: part.includes('\nnew file mode ')
          ? 'added'
          : part.includes('\ndeleted file mode ')
            ? 'deleted'
            : part.includes('\nrename from ')
              ? 'renamed'
              : 'modified',
      };
    })
    .filter(Boolean)
    .sort(fileSort);

/** @param {Extract<ReviewSource, {type: 'arc-working-tree' | 'arc-branch' | 'arc-range' | 'arc-commit' | 'arc-pull-request'}>} source */
const createArcDiffArgs = (source) => {
  if (source.type === 'arc-pull-request') {
    return ['pr', 'changes', String(source.number)];
  }

  const diffArgs =
    source.type === 'arc-branch'
      ? ['-B', source.base]
      : source.type === 'arc-range'
        ? source.symmetric
          ? ['-B', source.base, source.head]
          : [source.base, source.head]
        : source.type === 'arc-commit'
          ? [`${source.ref}^`, source.ref]
          : [];

  return ['diff', '--git', '--no-color', ...diffArgs];
};

/**
 * @param {string} repoRoot
 * @param {Extract<ReviewSource, {type: 'arc-working-tree' | 'arc-branch' | 'arc-range' | 'arc-commit' | 'arc-pull-request'}>} source
 * @param {ReadonlyArray<string>} [paths]
 * @param {{showWhitespace?: boolean}} [options]
 */
const readArcPatch = (repoRoot, source, paths = [], options = {}) =>
  source.type === 'arc-pull-request'
    ? arc(repoRoot, createArcDiffArgs(source))
    : arc(repoRoot, [
        ...createArcDiffArgs(source),
        ...getWhitespaceDiffArgs(options),
        ...(paths.length > 0 ? ['--', ...paths] : []),
      ]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value != null;

/** @param {unknown} value */
const optionalString = (value) => (typeof value === 'string' && value ? value : undefined);

/** @param {unknown} value */
const optionalNumber = (value) => {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
};

/**
 * @param {string} repoRoot
 * @param {Extract<ReviewSource, {type: 'arc-pull-request'}>} source
 */
const readArcPullRequestSource = async (repoRoot, source) => {
  try {
    const parsed = JSON.parse(
      await arc(repoRoot, ['pr', 'status', '--json', String(source.number)]),
    );
    if (!isObject(parsed)) {
      return source;
    }

    return {
      ...source,
      author: optionalString(parsed.author),
      fromBranch: optionalString(parsed.from_branch),
      headSha: optionalString(parsed.from_id),
      status: optionalString(parsed.status),
      title: optionalString(parsed.summary),
      toBranch: optionalString(parsed.to_branch),
      url: optionalString(parsed.url),
    };
  } catch {
    return source;
  }
};

/**
 * @param {unknown} raw
 * @param {number} prNumber
 * @param {string | undefined} prUrl
 * @returns {PullRequestExistingReviewComment | null}
 */
const normalizeArcanumReviewComment = (raw, prNumber, prUrl) => {
  if (!isObject(raw) || typeof raw.content !== 'string') {
    return null;
  }

  const reviewRequest = isObject(raw.anchor) ? raw.anchor.review_request : undefined;
  const diff = isObject(reviewRequest) ? reviewRequest.diff : undefined;
  const file = isObject(diff) ? diff.file : undefined;
  const position = isObject(file) ? file.position : undefined;
  const entryId = isObject(file) ? file.entry_id : undefined;
  const contentIdAfter = isObject(entryId) ? entryId.content_id_after : undefined;
  const contentIdBefore = isObject(entryId) ? entryId.content_id_before : undefined;
  const filePath =
    (isObject(contentIdAfter) && optionalString(contentIdAfter.path)) ||
    (isObject(contentIdBefore) && optionalString(contentIdBefore.path));
  const line = isObject(position) ? optionalNumber(position.line) : undefined;
  const size = isObject(position) ? optionalNumber(position.size) : undefined;
  if (!filePath || line == null || line < 1) {
    return null;
  }

  const rawSide = isObject(position) ? position.side : undefined;
  const side = rawSide === 'old' ? 'deletions' : 'additions';
  const lineCount = size != null && size > 1 ? Math.floor(size) : 1;
  const lineNumber = Math.floor(line + lineCount - 1);
  const user = isObject(raw.user) ? raw.user : undefined;
  const id = optionalNumber(raw.id);

  return {
    author: {
      login: (isObject(user) && optionalString(user.name)) || 'Arcanum user',
    },
    body: raw.content,
    filePath,
    id: `arcanum:${id ?? `${prNumber}:${filePath}:${lineNumber}`}`,
    lineNumber,
    side,
    ...(lineCount > 1 ? { startLineNumber: Math.floor(line), startSide: side } : {}),
    submittedAt: optionalString(raw.published_at) || optionalString(raw.created_at),
    ...(prUrl && id != null ? { url: `${prUrl}#comment-${id}` } : {}),
  };
};

/**
 * @param {string} repoRoot
 * @param {number} prNumber
 * @param {string | undefined} prUrl
 */
const readArcPullRequestComments = async (repoRoot, prNumber, prUrl) => {
  try {
    const payloads = parseMcpToolPayloads(
      await arcanum(repoRoot, 'arcanum_pr_data', { pr_id: prNumber }),
    );
    return payloads
      .flatMap((payload) => (isObject(payload) && Array.isArray(payload.data) ? payload.data : []))
      .map((comment) => normalizeArcanumReviewComment(comment, prNumber, prUrl))
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      `Could not load Arcanum comments for PR #${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/**
 * @param {string} repoRoot
 * @param {Extract<ReviewSource, {type: 'arc-working-tree' | 'arc-branch' | 'arc-range' | 'arc-commit' | 'arc-pull-request'}>} source
 */
const readArcStatus = async (repoRoot, source) =>
  source.type === 'arc-pull-request'
    ? parseArcPatchStatus(await readArcPatch(repoRoot, source))
    : source.type === 'arc-working-tree'
      ? mergeArcStatusItems(
          parseArcNameStatus(await arc(repoRoot, [...createArcDiffArgs(source), '--name-status'])),
          parseArcNameStatus(await arc(repoRoot, ['status', '--short', '-u', 'all'])).filter(
            (item) => item.status === 'untracked',
          ),
        )
      : parseArcNameStatus(await arc(repoRoot, [...createArcDiffArgs(source), '--name-status']));

/**
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} primary
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} extra
 */
const mergeArcStatusItems = (primary, extra) => {
  const paths = new Set(primary.map((item) => item.path));
  return [...primary, ...extra.filter((item) => !paths.has(item.path))].sort(fileSort);
};

/**
 * @param {string} repoRoot
 * @param {Pick<StatusItem, 'path' | 'status'>} item
 * @returns {Promise<DiffSection | null>}
 */
const createArcUntrackedSection = async (repoRoot, item) => {
  if (item.status !== 'untracked') {
    return null;
  }

  try {
    const path = validateRepositoryPath(item.path);
    const buffer = await readFile(join(repoRoot, path));
    const contents = bufferToTextFile(path, buffer, `arc-working-tree:${path}:${buffer.length}`);
    return {
      binary: contents.binary,
      id: `${item.path}:arc`,
      kind: 'arc',
      loadState: contents.binary ? 'binary' : 'ready',
      newFile: contents.file,
      patch: contents.file ? createPatchForNewFile(path, contents.file.contents) : '',
      ...(contents.summary ? { summary: contents.summary } : {}),
    };
  } catch (error) {
    return {
      binary: false,
      id: `${item.path}:arc`,
      kind: 'arc',
      loadState: 'error',
      patch: '',
      summary: createSummary(error instanceof Error ? error.message : String(error)),
    };
  }
};

/**
 * @param {Extract<ReviewSource, {type: 'arc-working-tree' | 'arc-branch' | 'arc-range' | 'arc-commit' | 'arc-pull-request'}>} source
 * @param {Pick<StatusItem, 'oldPath' | 'path' | 'status'>} item
 * @param {string} patch
 * @returns {Promise<ChangedFile>}
 */
const createArcFile = async (repoRoot, source, item, patch) => {
  const untrackedSection = await createArcUntrackedSection(repoRoot, item);
  /** @type {DiffSection} */
  const section = untrackedSection ?? {
    binary: /Binary files .* differ|GIT binary patch/.test(patch),
    id: `${item.path}:arc`,
    kind: 'arc',
    loadState: patch ? 'ready' : 'error',
    patch,
    ...(patch
      ? {}
      : {
          summary: createSummary('Codiff could not load this Arc diff.'),
        }),
  };

  return {
    fingerprint: getFingerprint(
      `${JSON.stringify(source)}\n${item.status}\n${item.oldPath || ''}\n${item.path}\n${
        section.patch
      }`,
    ),
    oldPath: item.oldPath,
    path: item.path,
    sections: [section],
    status: item.status,
  };
};

/** @param {string} patch */
const readArcPatchLineStats = (patch) => {
  if (/Binary files .* differ|GIT binary patch/.test(patch)) {
    return { binary: true };
  }

  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }

  return { additions, binary: false, deletions };
};

/**
 * @param {ReadonlyArray<ChangedFile>} files
 * @returns {Array<CommitMetadataFile>}
 */
const createArcCommitMetadataFiles = (files) =>
  files
    .map((file) => {
      const patch = file.sections.map((section) => section.patch).join('\n');
      const stats = readArcPatchLineStats(patch);
      return {
        binary: stats.binary,
        oldPath: file.oldPath,
        path: file.path,
        status: file.status,
        ...(stats.binary
          ? {}
          : {
              additions: stats.additions,
              deletions: stats.deletions,
            }),
      };
    })
    .sort(fileSort);

/** @param {ReadonlyArray<CommitMetadataFile>} files */
const createArcCommitMetadataStats = (files) => {
  const stats = {
    additions: 0,
    binaryFiles: 0,
    deletions: 0,
    files: files.length,
    renamedFiles: 0,
  };

  for (const file of files) {
    stats.additions += file.additions ?? 0;
    stats.binaryFiles += file.binary ? 1 : 0;
    stats.deletions += file.deletions ?? 0;
    stats.renamedFiles += file.oldPath ? 1 : 0;
  }

  return stats;
};

/** @param {string} message */
const splitArcCommitMessage = (message) => {
  const lines = message.split(/\r?\n/);
  const subjectIndex = lines.findIndex((line) => line.trim());
  if (subjectIndex === -1) {
    return { body: '', subject: '(no subject)' };
  }

  return {
    body: lines
      .slice(subjectIndex + 1)
      .join('\n')
      .replace(/^\s*\n/, '')
      .trimEnd(),
    subject: lines[subjectIndex],
  };
};

/** @param {string} raw */
const parseArcCommitTrailers = (raw) =>
  raw.split('\n').flatMap((line) => {
    const separator = line.indexOf(':');
    if (separator === -1) {
      return [];
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    return key && value ? [{ key, value }] : [];
  });

/** @param {string} repoRoot @param {string} ref */
const readArcCommitMessage = async (repoRoot, ref) => {
  const parsed = JSON.parse(await arc(repoRoot, ['log', '-n', '1', '--json', ref]));
  const entry = Array.isArray(parsed) ? parsed[0] : null;
  return isObject(entry) && typeof entry.message === 'string' ? entry.message : '';
};

/**
 * @param {string} repoRoot
 * @param {Extract<ReviewSource, {type: 'arc-commit'}>} source
 * @param {ReadonlyArray<ChangedFile>} files
 * @returns {Promise<CommitMetadata | undefined>}
 */
const readArcCommitMetadata = async (repoRoot, source, files) => {
  const logEntry = parseArcLogJson(
    await arc(repoRoot, ['log', '-n', '1', '--json', source.ref]),
  )[0];
  if (!logEntry) {
    return undefined;
  }

  const message = await readArcCommitMessage(repoRoot, source.ref);
  const messageParts = splitArcCommitMessage(message || logEntry.subject);
  const metadataFiles = createArcCommitMetadataFiles(files);
  const committedAt = logEntry.committedAt ? new Date(logEntry.committedAt).toISOString() : '';
  const author = logEntry.author || '';

  return {
    author: {
      date: committedAt,
      email: '',
      name: author,
    },
    body: messageParts.body,
    committer: {
      date: committedAt,
      email: '',
      name: author,
    },
    files: metadataFiles,
    parents: logEntry.parents,
    ref: logEntry.ref || source.ref,
    refs: [],
    shortRef: (logEntry.ref || source.ref).slice(0, 7),
    signature: {
      status: 'N',
    },
    stats: createArcCommitMetadataStats(metadataFiles),
    subject: messageParts.subject,
    trailers: parseArcCommitTrailers(messageParts.body),
  };
};

/**
 * @param {string} launchPath
 * @param {Extract<ReviewSource, {type: 'arc-working-tree' | 'arc-branch' | 'arc-range' | 'arc-commit' | 'arc-pull-request'}>} source
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readArcState = async (launchPath, source, options = {}) => {
  const repoRoot = await readArcRoot(launchPath);
  const [branch, rawPatch, resolvedSource] = await Promise.all([
    readArcBranchName(repoRoot),
    readArcPatch(repoRoot, source, [], options),
    source.type === 'arc-pull-request' ? readArcPullRequestSource(repoRoot, source) : source,
  ]);
  const reviewComments =
    resolvedSource.type === 'arc-pull-request'
      ? await readArcPullRequestComments(repoRoot, resolvedSource.number, resolvedSource.url)
      : undefined;
  const status =
    source.type === 'arc-pull-request'
      ? parseArcPatchStatus(rawPatch)
      : await readArcStatus(repoRoot, source);
  const patches = splitGitPatch(rawPatch);
  const files = await Promise.all(
    status.map((item) => createArcFile(repoRoot, source, item, findPatchForItem(patches, item))),
  );
  const commitMetadata =
    source.type === 'arc-commit' ? await readArcCommitMetadata(repoRoot, source, files) : undefined;

  return {
    branch,
    ...(commitMetadata ? { commitMetadata } : {}),
    files,
    generatedAt: Date.now(),
    launchPath,
    ...(reviewComments ? { reviewComments } : {}),
    root: repoRoot,
    source:
      source.type === 'arc-commit' && commitMetadata
        ? { ref: commitMetadata.ref, type: 'arc-commit' }
        : resolvedSource,
  };
};

/** @param {PullRequestReviewComment['side']} side */
const toArcanumDiffSide = (side) => (side === 'deletions' ? 'old' : 'new');

/** @param {PullRequestReviewComment} comment */
const getArcanumLineSpan = (comment) => {
  const startSide = comment.startSide ?? comment.side;
  if (
    typeof comment.startLineNumber === 'number' &&
    comment.startLineNumber !== comment.lineNumber &&
    startSide === comment.side
  ) {
    const start = Math.min(comment.startLineNumber, comment.lineNumber);
    const end = Math.max(comment.startLineNumber, comment.lineNumber);
    return { line: start, size: end - start + 1 };
  }

  return { line: comment.lineNumber, size: 1 };
};

/** @param {string} launchPath @param {SubmitPullRequestCommentRequest} request */
const submitArcPullRequestComment = async (launchPath, request) => {
  if (request.source.type !== 'arc-pull-request') {
    throw new Error('Arcadia comment submission requires an Arc pull request source.');
  }

  const repoRoot = await readArcRoot(launchPath);
  const span = getArcanumLineSpan(request.comment);
  const payloads = parseMcpToolPayloads(
    await arcanum(repoRoot, 'arcanum_post_comment', {
      comment_data: {
        content: request.comment.body,
        draft: false,
        issue_status: null,
      },
      diff_side: toArcanumDiffSide(request.comment.side),
      file_line_number: span.line,
      file_path: request.comment.filePath,
      lines_to_highlight: span.size,
      pr_id: request.source.number,
    }),
  );
  const submitted = payloads
    .flatMap((payload) => (isObject(payload) && 'data' in payload ? [payload.data] : [payload]))
    .map((comment) =>
      normalizeArcanumReviewComment(comment, request.source.number, request.source.url),
    )
    .find(Boolean);

  return (
    submitted ?? {
      author: { login: 'Arcanum user' },
      body: request.comment.body,
      filePath: request.comment.filePath,
      id: `arcanum:submitted:${Date.now()}`,
      lineNumber: request.comment.lineNumber,
      side: request.comment.side,
      ...(typeof request.comment.startLineNumber === 'number'
        ? {
            startLineNumber: request.comment.startLineNumber,
            startSide: request.comment.startSide ?? request.comment.side,
          }
        : {}),
      submittedAt: new Date().toISOString(),
      ...(request.source.url ? { url: request.source.url } : {}),
    }
  );
};

/** @param {string} launchPath @param {DiffSectionContentRequest} request */
const readArcSectionContent = async (launchPath, request) => {
  const source = request.source;
  if (
    source?.type !== 'arc-working-tree' &&
    source?.type !== 'arc-branch' &&
    source?.type !== 'arc-range' &&
    source?.type !== 'arc-commit' &&
    source?.type !== 'arc-pull-request'
  ) {
    throw new Error('Arc diff content requires an Arc source.');
  }

  const repoRoot = await readArcRoot(launchPath);
  const path = validateRepositoryPath(request.path);
  const rawPatch =
    source.type === 'arc-pull-request'
      ? await readArcPatch(repoRoot, source)
      : await readArcPatch(repoRoot, source, [path], {
          showWhitespace: request.showWhitespace,
        });
  const status =
    source.type === 'arc-pull-request'
      ? parseArcPatchStatus(rawPatch)
      : await readArcStatus(repoRoot, source);
  const item = status.find((candidate) => candidate.path === path);
  if (!item) {
    throw new Error('File is not part of this Arc diff.');
  }
  const patch = findPatchForItem(splitGitPatch(rawPatch), item);
  return (await createArcFile(repoRoot, source, item, patch)).sections[0];
};

/**
 * @param {string} repoRoot
 * @param {Extract<ReviewSource, {type: 'arc-branch' | 'arc-range' | 'arc-commit' | 'arc-pull-request'}>} source
 * @returns {Promise<{newRef: string; oldRef?: string}>}
 */
const resolveArcImageRefs = async (repoRoot, source) => {
  if (source.type === 'arc-commit') {
    return { newRef: source.ref, oldRef: `${source.ref}^` };
  }

  if (source.type === 'arc-pull-request') {
    const resolved = await readArcPullRequestSource(repoRoot, source);
    if (!resolved.headSha) {
      throw new Error(`Arc PR #${source.number} did not report a head commit.`);
    }
    const base = resolved.toBranch || 'trunk';
    return {
      newRef: resolved.headSha,
      oldRef: (await arc(repoRoot, ['merge-base', base, resolved.headSha])).trim(),
    };
  }

  if (source.type === 'arc-range') {
    return {
      newRef: source.head,
      oldRef: source.symmetric
        ? (await arc(repoRoot, ['merge-base', source.base, source.head])).trim()
        : source.base,
    };
  }

  return {
    newRef: 'HEAD',
    oldRef: (await arc(repoRoot, ['merge-base', source.base, 'HEAD'])).trim(),
  };
};

/** @param {string} repoRoot @param {string | undefined} ref @param {string} path */
const readArcImageFile = async (repoRoot, ref, path) => {
  if (!ref) {
    return undefined;
  }

  try {
    return bufferToImageRevision(path, await arcBuffer(repoRoot, ['show', `${ref}:${path}`]));
  } catch {
    return undefined;
  }
};

/**
 * @param {string} launchPath
 * @param {import('../../core/types.ts').DiffImageContentRequest} request
 * @returns {Promise<DiffImageContentResult>}
 */
const readArcImageContent = async (launchPath, request) => {
  const source = request.source;
  if (
    source?.type !== 'arc-working-tree' &&
    source?.type !== 'arc-branch' &&
    source?.type !== 'arc-range' &&
    source?.type !== 'arc-commit' &&
    source?.type !== 'arc-pull-request'
  ) {
    return {
      reason: 'Image previews are not available for this Arc source.',
      status: 'unavailable',
    };
  }

  const repoRoot = await readArcRoot(launchPath);
  const path = validateRepositoryPath(request.path);
  if (source.type !== 'arc-working-tree') {
    try {
      const item = (await readArcStatus(repoRoot, source)).find(
        (candidate) => candidate.path === path,
      );
      if (!item) {
        return {
          reason: 'Image file is not part of this Arc diff.',
          status: 'unavailable',
        };
      }
      const refs = await resolveArcImageRefs(repoRoot, source);
      const [oldImage, newImage] = await Promise.all([
        item.status === 'added'
          ? undefined
          : readArcImageFile(repoRoot, refs.oldRef, item.oldPath || item.path),
        item.status === 'deleted' ? undefined : readArcImageFile(repoRoot, refs.newRef, item.path),
      ]);
      return oldImage || newImage
        ? {
            ...(oldImage ? { oldImage } : {}),
            ...(newImage ? { newImage } : {}),
            status: 'ready',
          }
        : {
            reason: 'Image file is not available in this Arc diff.',
            status: 'unavailable',
          };
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : String(error),
        status: 'unavailable',
      };
    }
  }

  const item = (await readArcStatus(repoRoot, source)).find((candidate) => candidate.path === path);
  if (item?.status !== 'added' && item?.status !== 'untracked') {
    return {
      reason: 'Arc image previews are only supported for added or untracked files.',
      status: 'unavailable',
    };
  }

  try {
    const newImage = await readWorkingTreeImageFile(repoRoot, path);
    return newImage
      ? {
          newImage,
          status: 'ready',
        }
      : {
          reason: 'Image file is not available in the Arc working tree.',
          status: 'unavailable',
        };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
};

/** @param {string} message */
const getArcLogSubject = (message) => message.split('\n').find(Boolean) || '(no subject)';

/** @param {unknown} raw */
const normalizeArcLogEntry = (raw) => {
  if (!isObject(raw) || typeof raw.commit !== 'string') {
    return null;
  }

  const parents = Array.isArray(raw.parents)
    ? raw.parents.filter((parent) => typeof parent === 'string')
    : [];
  const message = typeof raw.message === 'string' ? raw.message : '';
  const date = typeof raw.date === 'string' ? Date.parse(raw.date) : NaN;

  return {
    author: typeof raw.author === 'string' ? raw.author : '',
    committedAt: Number.isFinite(date) ? date : 0,
    parents,
    ref: raw.commit,
    subject: getArcLogSubject(message),
  };
};

/** @param {string} raw */
const parseArcLogJson = (raw) => {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.map(normalizeArcLogEntry).filter(Boolean) : [];
};

/** @param {string} repoRoot */
const readArcHead = async (repoRoot) => {
  try {
    return parseArcLogJson(await arc(repoRoot, ['log', '-n', '1', '--json']))[0]?.ref ?? '';
  } catch {
    return '';
  }
};

/** @param {string} launchPath @param {Iterable<string>} [additionalPaths] */
const readArcRepositoryChangeSignature = async (launchPath, additionalPaths = []) => {
  const repoRoot = await readArcRoot(launchPath);
  const [head, workingTreeSignatures] = await Promise.all([
    readArcHead(repoRoot),
    readArcWorkingTreeChangeSignatures(repoRoot, additionalPaths),
  ]);
  const workingTree = workingTreeSignatures.map(([, signature]) => signature).join('\0');

  return {
    head,
    pathSignatures: Object.fromEntries(workingTreeSignatures),
    root: repoRoot,
    signature: getFingerprint([head, workingTree].join('\0')),
  };
};

/** @param {string} launchPath */
const readArcIdentity = async (launchPath) => {
  const repoRoot = await readArcRoot(launchPath);
  const parsed = JSON.parse(await arc(repoRoot, ['info', '--json']));
  const info = isObject(parsed) ? parsed : {};
  const login =
    (typeof info.user_login === 'string' && info.user_login.trim()) ||
    (typeof info.author === 'string' && info.author.trim()) ||
    '';

  return {
    email: '',
    name: login,
  };
};

/** @param {string} raw */
const parseArcPullRequestHistoryJson = (raw) => {
  const parsed = JSON.parse(raw);
  const iterations = isObject(parsed) && Array.isArray(parsed.iterations) ? parsed.iterations : [];
  return iterations
    .map((iteration) => {
      if (!isObject(iteration) || typeof iteration.commit !== 'string') {
        return null;
      }
      const timestamp =
        typeof iteration.timestamp === 'string' ? Date.parse(iteration.timestamp) : NaN;
      return {
        author: '',
        committedAt: Number.isFinite(timestamp) ? timestamp : 0,
        parents: [],
        ref: iteration.commit,
        subject:
          typeof iteration.message === 'string'
            ? getArcLogSubject(iteration.message)
            : '(no subject)',
      };
    })
    .filter(Boolean);
};

/**
 * @param {string} launchPath
 * @param {number} [limit]
 * @param {ReviewSource} [source]
 * @returns {Promise<RepositoryHistory>}
 */
const listArcRepositoryHistory = async (launchPath, limit = 50, source) => {
  const repoRoot = await readArcRoot(launchPath);
  if (source?.type === 'arc-pull-request') {
    const output = await arc(repoRoot, ['pr', 'history', '--json', String(source.number)]);
    return {
      entries: parseArcPullRequestHistoryJson(output).slice(0, limit),
      root: repoRoot,
    };
  }

  const range = source?.type === 'arc-branch' ? `${source.base}..HEAD` : '';
  const output = await arc(repoRoot, [
    'log',
    '-n',
    String(limit),
    '--json',
    ...(range ? [range] : []),
  ]);
  return {
    entries: parseArcLogJson(output),
    root: repoRoot,
  };
};

module.exports = {
  listArcRepositoryHistory,
  normalizeArcanumReviewComment,
  parseArcNameStatus,
  readArcIdentity,
  readArcImageContent,
  readArcRepositoryChangeSignature,
  readArcSectionContent,
  readArcState,
  submitArcPullRequestComment,
};
