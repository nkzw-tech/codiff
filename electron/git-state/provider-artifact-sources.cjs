// @ts-check

const { loadGitHubHistory } = require('../github-history-bridge.cjs');
const { loadGitLabHistory } = require('../gitlab-history-bridge.cjs');
const { git, gitBufferWithInput } = require('./common.cjs');
const { createGhGitHubTransport } = require('./github-history/gh-github-transport.cjs');
const { createGlabGitLabTransport } = require('./glab-gitlab-transport.cjs');

const fileBlobReadConcurrency = 8;

/** @param {{host?: string, owner: string, repo: string}} pull */
const githubArtifactProject = (pull) => ({
  host: pull.host || 'github.com',
  project: `${pull.owner}/${pull.repo}`,
  provider: /** @type {const} */ ('github'),
});

/** @param {{host: string, projectPath: string}} mergeRequest */
const gitlabArtifactProject = (mergeRequest) => ({
  host: mergeRequest.host,
  project: mergeRequest.projectPath,
  provider: /** @type {const} */ ('gitlab'),
});

/** @param {{path: string, ref: string}} request */
const fileBlobRequestKey = (request) => `${request.ref}:${request.path}`;

/**
 * Resolve immutable ref+path coordinates from native Git in one bounded batch.
 * @param {string} repoRoot
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project
 * @param {ReadonlyArray<{maxBytes: number, path: string, ref: string, signal?: AbortSignal}>} requests
 */
const readNativeFileBlobArtifacts = async (repoRoot, project, requests) => {
  const pending = [
    ...new Map(requests.map((request) => [fileBlobRequestKey(request), request])).values(),
  ];
  /** @type {Map<string, import('../../core/lib/review-artifacts.ts').BlobArtifact>} */
  const blobs = new Map();
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < pending.length) {
      const request = pending[nextIndex++];
      request.signal?.throwIfAborted();
      try {
        const coordinate = `${request.ref}:${request.path}`;
        const objectId = (await git(repoRoot, ['rev-parse', '--verify', coordinate])).trim();
        if (!/^[\da-f]{40,64}$/i.test(objectId)) {
          continue;
        }
        const size = Number.parseInt(
          (await git(repoRoot, ['cat-file', '-s', objectId])).trim(),
          10,
        );
        if (!Number.isFinite(size) || size > request.maxBytes) {
          continue;
        }
        const bytes = await gitBufferWithInput(repoRoot, ['show', coordinate], '');
        if (bytes.byteLength <= request.maxBytes) {
          blobs.set(fileBlobRequestKey(request), {
            bytes,
            objectId,
            provenance: { kind: 'native-git', project },
          });
        }
      } catch {
        request.signal?.throwIfAborted();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(fileBlobReadConcurrency, pending.length) }, worker),
  );
  return blobs;
};

/**
 * Resolve GitHub ref+path coordinates through native Git first and the
 * canonical API Artifact Source second. Returned bytes carry Git object IDs.
 * @param {string} repoRoot
 * @param {{host?: string, number?: number, owner: string, repo: string}} pull
 * @param {ReadonlyArray<{maxBytes: number, path: string, ref: string, signal?: AbortSignal}>} requests
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 */
const readGitHubFileBlobArtifacts = async (repoRoot, pull, requests, transport) => {
  const signal = requests.find((request) => request.signal)?.signal || new AbortController().signal;
  const coordinates = requests.map(({ maxBytes, path, ref }) => ({ maxBytes, path, ref }));
  const project = githubArtifactProject(pull);
  const maxBytes = Math.max(0, ...coordinates.map((request) => request.maxBytes));
  const local = await readNativeFileBlobArtifacts(
    repoRoot,
    project,
    coordinates.map((coordinate) => ({ ...coordinate, signal })),
  );
  const missing = coordinates.filter((coordinate) => !local.has(fileBlobRequestKey(coordinate)));
  if (missing.length === 0) {
    return local;
  }
  const source = (await loadGitHubHistory()).createGitHubArtifactSource({
    maxBlobArtifactBytes: maxBytes,
    project,
    pull: { ...pull, number: pull.number || 0 },
    transport: transport || createGhGitHubTransport({ repoRoot }),
  });
  const provider = (await source.readFileBlobs?.(missing, signal)) || new Map();
  return new Map([...local, ...provider]);
};

/**
 * Resolve GitLab ref+path coordinates through native Git first and the
 * canonical API Artifact Source second. Returned bytes carry Git object IDs.
 * @param {string} repoRoot
 * @param {{host: string, projectPath: string}} mergeRequest
 * @param {ReadonlyArray<{maxBytes: number, path: string, ref: string, signal?: AbortSignal}>} requests
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readGitLabFileBlobArtifacts = async (repoRoot, mergeRequest, requests, transport) => {
  const signal = requests.find((request) => request.signal)?.signal || new AbortController().signal;
  const coordinates = requests.map(({ maxBytes, path, ref }) => ({ maxBytes, path, ref }));
  const project = gitlabArtifactProject(mergeRequest);
  const maxBytes = Math.max(0, ...coordinates.map((request) => request.maxBytes));
  const local = await readNativeFileBlobArtifacts(
    repoRoot,
    project,
    coordinates.map((coordinate) => ({ ...coordinate, signal })),
  );
  const missing = coordinates.filter((coordinate) => !local.has(fileBlobRequestKey(coordinate)));
  if (missing.length === 0) {
    return local;
  }
  const source = (await loadGitLabHistory()).createGitLabArtifactSource({
    maxBlobArtifactBytes: maxBytes,
    project,
    projectPath: mergeRequest.projectPath,
    transport: transport || createGlabGitLabTransport({ hostname: mergeRequest.host, repoRoot }),
  });
  const provider = (await source.readFileBlobs?.(missing, signal)) || new Map();
  return new Map([...local, ...provider]);
};

module.exports = {
  githubArtifactProject,
  gitlabArtifactProject,
  readGitHubFileBlobArtifacts,
  readGitLabFileBlobArtifacts,
  readNativeFileBlobArtifacts,
};
