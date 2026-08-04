// @ts-check

const {
  MANUAL_TEXT_FILE_LIMIT,
  formatBytes,
  getCurrentCommandSignal,
  runWithCommandSignal,
} = require('./git-state/common.cjs');
const {
  readGitHubFileBlobArtifacts,
  readGitLabFileBlobArtifacts,
  readNativeFileBlobArtifacts,
} = require('./git-state/provider-artifact-sources.cjs');

/**
 * @typedef {import('../core/types.ts').ReviewContextRequest} ReviewContextRequest
 * @typedef {import('../core/types.ts').ReviewContextResult} ReviewContextResult
 * @typedef {{cacheKey: string; contents: string; name: string}} ReviewContextFile
 */

/** @param {unknown} error */
const getErrorMessage = (error) =>
  error instanceof Error ? error.message : String(error || 'Unknown provider error.');

/** @param {ReviewContextRequest['source']} source */
const getProviderIdentity = (source) => {
  if (source.type !== 'pull-request') {
    return null;
  }

  const provider =
    source.provider ??
    (source.url.includes('gitlab') || source.url.includes('/-/merge_requests/')
      ? 'gitlab'
      : source.url.includes('github')
        ? 'github'
        : null);
  if (provider === 'gitlab') {
    const projectPath = source.projectPath?.trim();
    const hostname = source.host?.trim();
    return projectPath && hostname
      ? { hostname, projectPath, provider: /** @type {const} */ ('gitlab') }
      : null;
  }
  if (provider === 'github') {
    const [projectOwner, ...projectRepoParts] = source.projectPath?.split('/') ?? [];
    const owner = source.owner?.trim() || projectOwner?.trim();
    const repo = source.repo?.trim() || projectRepoParts.join('/').trim();
    return owner && repo
      ? {
          hostname: source.host?.trim() || 'github.com',
          owner,
          projectPath: `${owner}/${repo}`,
          provider: /** @type {const} */ ('github'),
          repo,
        }
      : null;
  }
  return null;
};

/** @param {string} cacheKey @param {string} contents @param {string} name */
const createContextFile = (cacheKey, contents, name) => ({ cacheKey, contents, name });

const MAX_REVIEW_CONTEXT_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_REVIEW_CONTEXT_CACHE_ENTRIES = 16;

/** @param {AbortSignal | undefined} signal */
const throwIfContextAborted = (signal) => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Review context request was canceled.', 'AbortError');
};

/** @param {unknown} error */
const isContextAbortError = (error) => error instanceof Error && error.name === 'AbortError';

/**
 * @param {Promise<ReviewContextFile>} promise
 * @param {{controller: AbortController, consumers: number} | null} pending
 * @param {AbortSignal | undefined} signal
 */
const waitForContextConsumer = (promise, pending, signal) => {
  throwIfContextAborted(signal);
  if (!pending || !signal) return promise;
  pending.consumers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value, abortUnderlying = false) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      pending.consumers -= 1;
      if (abortUnderlying && pending.consumers === 0) {
        pending.controller.abort(
          new DOMException('Review context request was canceled.', 'AbortError'),
        );
      }
      callback(value);
    };
    const onAbort = () =>
      finish(
        reject,
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Review context request was canceled.', 'AbortError'),
        true,
      );
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
};

const createContextOutputLimitError = () => {
  const error = new Error(
    `Full review context is limited to ${formatBytes(MANUAL_TEXT_FILE_LIMIT)} per file.`,
  );
  error.name = 'ReviewContextOutputLimitError';
  return error;
};

/** @param {unknown} error */
const isContextOutputLimitError = (error) =>
  error instanceof Error &&
  (error.name === 'GitOutputLimitError' ||
    error.name === 'ProviderOutputLimitError' ||
    error.name === 'ReviewContextOutputLimitError');

/** @param {string} contents */
const assertContextFileWithinLimit = (contents) => {
  if (Buffer.byteLength(contents, 'utf8') > MANUAL_TEXT_FILE_LIMIT) {
    throw createContextOutputLimitError();
  }
  return contents;
};

/**
 * @param {{
 *   maxCacheBytes?: number,
 *   maxCacheEntries?: number,
 *   readFileBlobs?: (repoRoot: string, request: ReviewContextRequest, files: ReadonlyArray<{maxBytes: number, path: string, ref: string}>) => Promise<ReadonlyMap<string, import('../core/lib/review-artifacts.ts').BlobArtifact>>,
 * }} [dependencies]
 */
const createReviewContextResolver = (dependencies = {}) => {
  const readFileBlobs =
    dependencies.readFileBlobs ??
    (async (repoRoot, request, files) => {
      const provider = getProviderIdentity(request.source);
      if (provider?.provider === 'gitlab') {
        return readGitLabFileBlobArtifacts(
          repoRoot,
          { host: provider.hostname, projectPath: provider.projectPath },
          files,
        );
      }
      if (provider?.provider === 'github') {
        return readGitHubFileBlobArtifacts(
          repoRoot,
          {
            host: provider.hostname,
            number: request.source.type === 'pull-request' ? request.source.number : undefined,
            owner: provider.owner,
            repo: provider.repo,
          },
          files,
        );
      }
      return readNativeFileBlobArtifacts(
        repoRoot,
        { host: 'local', project: repoRoot, provider: 'git' },
        files,
      );
    });
  const maxCacheBytes = dependencies.maxCacheBytes ?? MAX_REVIEW_CONTEXT_CACHE_BYTES;
  const maxCacheEntries = dependencies.maxCacheEntries ?? MAX_REVIEW_CONTEXT_CACHE_ENTRIES;
  /** @type {Map<string, {bytes: number | null, promise: Promise<ReviewContextFile>}>} */
  const blobCache = new Map();
  let cachedBytes = 0;

  /** @param {string} key @param {{bytes: number | null, pending: {controller: AbortController, consumers: number} | null, promise: Promise<ReviewContextFile>}} entry */
  const touchCacheEntry = (key, entry) => {
    blobCache.delete(key);
    blobCache.set(key, entry);
  };
  const trimBlobCache = () => {
    for (const [key, entry] of blobCache) {
      if (blobCache.size <= maxCacheEntries && cachedBytes <= maxCacheBytes) break;
      if (entry.bytes == null) continue;
      blobCache.delete(key);
      cachedBytes -= entry.bytes;
    }
  };

  /**
   * @param {string} repoRoot
   * @param {ReviewContextRequest} request
   * @param {ReadonlyArray<{path: string, sha: string}>} files
   */
  const readImmutableBlobs = (repoRoot, request, files) => {
    const signal = getCurrentCommandSignal();
    throwIfContextAborted(signal);
    const provider = getProviderIdentity(request.source);
    const namespace = provider
      ? `${provider.provider}:${provider.hostname}:${provider.projectPath}`
      : `local:${repoRoot}`;
    const entries = files.map(({ path, sha }) => ({
      cacheKey: `${namespace}:${sha}:${path}`,
      path,
      sha,
    }));
    for (const { cacheKey } of entries) {
      const cached = blobCache.get(cacheKey);
      if (cached) touchCacheEntry(cacheKey, cached);
    }
    const missing = entries.filter(({ cacheKey }) => !blobCache.has(cacheKey));
    if (missing.length > 0) {
      const pendingBatch = { controller: new AbortController(), consumers: 0 };
      const batch = Promise.resolve().then(() =>
        runWithCommandSignal(pendingBatch.controller.signal, () =>
          readFileBlobs(
            repoRoot,
            request,
            missing.map(({ path, sha }) => ({
              maxBytes: MANUAL_TEXT_FILE_LIMIT,
              path,
              ref: sha,
            })),
          ),
        ),
      );
      for (const entry of missing) {
        /** @type {{bytes: number | null, pending: {controller: AbortController, consumers: number} | null, promise: Promise<ReviewContextFile>} | undefined} */
        let cacheEntry;
        const pending = batch
          .then((blobs) => {
            throwIfContextAborted(pendingBatch.controller.signal);
            const blob = blobs.get(`${entry.sha}:${entry.path}`);
            if (!blob) {
              const source = provider
                ? `${provider.provider === 'gitlab' ? 'GitLab' : 'GitHub'} Blob Artifact source`
                : 'Native Git Blob Artifact source';
              throw new Error(`${source} did not return this immutable file.`);
            }
            if (blob.bytes.byteLength > MANUAL_TEXT_FILE_LIMIT) {
              throw createContextOutputLimitError();
            }
            const contents = assertContextFileWithinLimit(Buffer.from(blob.bytes).toString('utf8'));
            const file = createContextFile(entry.cacheKey, contents, entry.path);
            if (cacheEntry && blobCache.get(entry.cacheKey) === cacheEntry) {
              cacheEntry.bytes = Buffer.byteLength(contents, 'utf8');
              cacheEntry.pending = null;
              cachedBytes += cacheEntry.bytes;
              touchCacheEntry(entry.cacheKey, cacheEntry);
              trimBlobCache();
            }
            return file;
          })
          .catch((error) => {
            if (cacheEntry && blobCache.get(entry.cacheKey) === cacheEntry) {
              if (cacheEntry.bytes != null) cachedBytes -= cacheEntry.bytes;
              blobCache.delete(entry.cacheKey);
            }
            if (isContextOutputLimitError(error)) {
              throw createContextOutputLimitError();
            }
            throw error;
          });
        cacheEntry = { bytes: null, pending: pendingBatch, promise: pending };
        blobCache.set(entry.cacheKey, cacheEntry);
      }
      trimBlobCache();
    }
    return entries.map(({ cacheKey }) => {
      const entry = blobCache.get(cacheKey);
      return entry ? waitForContextConsumer(entry.promise, entry.pending, signal) : undefined;
    });
  };

  /**
   * @param {string} repoRoot
   * @param {ReviewContextRequest} request
   * @returns {Promise<ReviewContextResult>}
   */
  const resolveContext = async (repoRoot, request) => {
    const signal = getCurrentCommandSignal();
    throwIfContextAborted(signal);
    const beforePath = request.oldPath || request.filePath;
    const needsBefore =
      request.status === 'deleted' || request.status === 'modified' || request.status === 'renamed';
    const needsAfter = request.status !== 'deleted';
    const reads = [
      ...(needsBefore
        ? [
            {
              label: 'before',
              path: beforePath,
              sha: request.baseSha,
            },
          ]
        : []),
      ...(needsAfter
        ? [
            {
              label: 'after',
              path: request.filePath,
              sha: request.headSha,
            },
          ]
        : []),
    ];
    const promises = readImmutableBlobs(repoRoot, request, reads).map(
      (promise) =>
        promise || Promise.reject(new Error('Blob Artifact cache entry is unavailable.')),
    );
    const results = await Promise.allSettled(promises);
    throwIfContextAborted(signal);
    const failedIndex = results.findIndex((result) => result.status === 'rejected');
    if (failedIndex !== -1) {
      const failed = reads[failedIndex];
      const result = results[failedIndex];
      if (result.status === 'rejected' && isContextAbortError(result.reason)) {
        throw result.reason;
      }
      return {
        reason: `Full review context is unavailable for '${request.filePath}': could not load ${failed.label} contents at ${failed.sha.slice(0, 12)}:${failed.path}. ${getErrorMessage(result.status === 'rejected' ? result.reason : '')}`,
        status: 'unavailable',
      };
    }

    const files = results.map((result) => (result.status === 'fulfilled' ? result.value : null));
    const beforeFile = needsBefore ? files[0] : null;
    const afterFile = needsAfter ? files.at(-1) : null;
    return {
      newFile:
        afterFile ??
        createContextFile(`${request.headSha}:${request.filePath}:empty`, '', request.filePath),
      oldFile: beforeFile,
      status: 'ready',
    };
  };
  return Object.assign(resolveContext, {
    getCacheStats: () => ({ bytes: cachedBytes, entries: blobCache.size }),
  });
};

const resolveReviewContext = createReviewContextResolver();

module.exports = {
  createReviewContextResolver,
  resolveReviewContext,
};
