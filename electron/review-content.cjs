// @ts-check

const { promises: fs } = require('node:fs');
const { join } = require('node:path');
const {
  formatBytes,
  getCurrentCommandSignal,
  git,
  gitBufferWithInput,
  validateRepositoryPath,
} = require('./git-state/common.cjs');
const { createCommitContentAdapter } = require('./git-state/provider-artifact-sources.cjs');

/** @typedef {import('../core/types.ts').RevisionContentBatchRequest} RevisionContentBatchRequest */
/** @typedef {import('../core/types.ts').RevisionContentItemResult} RevisionContentItemResult */
/** @typedef {import('../core/types.ts').ResolvedRevisionBytes} ResolvedRevisionBytes */

/** @param {unknown} error */
const getErrorMessage = (error) => (error instanceof Error ? error.message : String(error));

/** @param {import('../core/types.ts').Revision} revision */
const getRevisionKind = (revision) => revision.kind || 'commit';

/** @param {string} repoRoot @param {string} spec @param {number} maxBytes */
const readGitSpec = async (repoRoot, spec, maxBytes) => {
  let objectId;
  let size;
  try {
    objectId = (await git(repoRoot, ['rev-parse', '--verify', spec])).trim();
    size = Number.parseInt((await git(repoRoot, ['cat-file', '-s', objectId])).trim(), 10);
  } catch {
    getCurrentCommandSignal()?.throwIfAborted();
    return null;
  }
  if (!Number.isFinite(size)) {
    return null;
  }
  if (size > maxBytes) {
    throw new Error(
      `File is ${formatBytes(size)}, exceeding the ${formatBytes(maxBytes)} content limit.`,
    );
  }
  const bytes = await gitBufferWithInput(repoRoot, ['cat-file', 'blob', objectId], '');
  return { bytes, objectId, size };
};

/**
 * @param {string} repoRoot
 * @param {RevisionContentBatchRequest['requests'][number]} request
 * @returns {Promise<ResolvedRevisionBytes | null>}
 */
const readMutableRevision = async (repoRoot, request) => {
  const path = validateRepositoryPath(request.path);
  if (request.revision.kind === 'index') {
    const stage = request.revision.stage;
    const spec = stage ? `:${stage}:${path}` : `:${path}`;
    const result = await readGitSpec(repoRoot, spec, request.maxBytes);
    return result
      ? {
          bytes: result.bytes,
          cacheKey: `index:${stage || 0}:${result.objectId}:${path}`,
          objectId: result.objectId,
          path,
          provenance: /** @type {const} */ ('git-index'),
          size: result.size,
        }
      : null;
  }

  const absolutePath = join(repoRoot, path);
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch {
    getCurrentCommandSignal()?.throwIfAborted();
    return null;
  }
  if (stat.isDirectory()) {
    throw new Error('Path is a directory, so Codiff cannot load it as file content.');
  }
  const bytes = stat.isSymbolicLink()
    ? Buffer.from(await fs.readlink(absolutePath), 'utf8')
    : stat.isFile()
      ? await fs.readFile(absolutePath)
      : null;
  if (!bytes) {
    throw new Error('Path is not a regular file.');
  }
  if (bytes.byteLength > request.maxBytes) {
    throw new Error(
      `File is ${formatBytes(bytes.byteLength)}, exceeding the ${formatBytes(request.maxBytes)} content limit.`,
    );
  }
  return {
    bytes,
    cacheKey: `working-copy:${request.key}:${bytes.byteLength}`,
    path,
    provenance: /** @type {const} */ ('filesystem'),
    size: bytes.byteLength,
  };
};

/**
 * Dispatch exact file reads only by Revision kind. Commit transport selection
 * is captured once by the source-scoped adapter; callers never rediscover a
 * source from section presentation metadata.
 * @param {string} launchPath
 * @param {RevisionContentBatchRequest} batch
 * @returns {Promise<import('../core/types.ts').RevisionContentBatchResult>}
 */
const readRevisionContent = async (launchPath, batch) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const signal = getCurrentCommandSignal();
  signal?.throwIfAborted();
  const requests = [...new Map(batch.requests.map((request) => [request.key, request])).values()];
  const commitRequests = requests.filter(
    (request) => getRevisionKind(request.revision) === 'commit',
  );
  const adapter = createCommitContentAdapter(repoRoot, batch.source);
  const commitBlobs =
    commitRequests.length === 0
      ? new Map()
      : await adapter.readFileBlobs(
          commitRequests.map((request) => ({
            maxBytes: request.maxBytes,
            path: validateRepositoryPath(request.path),
            ref: 'sha' in request.revision ? request.revision.sha : '',
            ...(signal ? { signal } : {}),
          })),
        );
  signal?.throwIfAborted();

  /** @type {Array<Promise<RevisionContentItemResult>>} */
  const reads = requests.map(async (request) => {
    try {
      const kind = getRevisionKind(request.revision);
      const value =
        kind === 'commit'
          ? (() => {
              const ref = 'sha' in request.revision ? request.revision.sha : '';
              const blob = commitBlobs.get(`${ref}:${request.path}`);
              return blob
                ? {
                    bytes: blob.bytes,
                    cacheKey: `${blob.provenance.kind}:${blob.objectId}:${request.path}`,
                    objectId: blob.objectId,
                    path: request.path,
                    provenance: blob.provenance.kind,
                    size: blob.bytes.byteLength,
                  }
                : null;
            })()
          : await readMutableRevision(repoRoot, request);
      return value
        ? { key: request.key, status: /** @type {const} */ ('ready'), value }
        : { key: request.key, status: /** @type {const} */ ('missing') };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        key: request.key,
        reason: getErrorMessage(error),
        status: /** @type {const} */ ('unavailable'),
      };
    }
  });
  return { results: await Promise.all(reads) };
};

module.exports = { readRevisionContent };
