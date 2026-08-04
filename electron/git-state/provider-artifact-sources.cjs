// @ts-check

const { getCommandActionSignal } = require('../command-log.cjs');
const { loadGitHubHistory } = require('../github-history-bridge.cjs');
const { loadGitLabHistory } = require('../gitlab-history-bridge.cjs');
const { createGhGitHubTransport } = require('./github-history/gh-github-transport.cjs');
const { createGlabGitLabTransport } = require('./glab-gitlab-transport.cjs');
const { createNativeCommitArtifactSource } = require('./commit-artifacts.cjs');
const { getComparisonArtifactRun } = require('./review-artifact-run.cjs');

const githubRangeDiffSemantics = 'github-repository-compare-v1';
const gitlabRangeDiffSemantics = 'gitlab-repository-compare-straight-v1';

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

/**
 * @param {string} repoRoot
 * @param {{host?: string, number: number, owner: string, repo: string}} pull
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 */
const createGitHubArtifactBackend = (repoRoot, pull, transport) => ({
  createSource: async () =>
    (await loadGitHubHistory()).createGitHubArtifactSource({
      project: githubArtifactProject(pull),
      pull,
      transport: transport || createGhGitHubTransport({ repoRoot }),
    }),
  diffSemantics: githubRangeDiffSemantics,
  identity: 'github-api',
  provenanceKind: /** @type {const} */ ('github-api'),
});

/**
 * @param {string} repoRoot
 * @param {{host: string, projectPath: string}} mergeRequest
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const createGitLabArtifactBackend = (repoRoot, mergeRequest, transport) => ({
  createSource: async () =>
    (await loadGitLabHistory()).createGitLabArtifactSource({
      project: gitlabArtifactProject(mergeRequest),
      projectPath: mergeRequest.projectPath,
      transport: transport || createGlabGitLabTransport({ hostname: mergeRequest.host, repoRoot }),
    }),
  diffSemantics: gitlabRangeDiffSemantics,
  identity: 'gitlab-api',
  provenanceKind: /** @type {const} */ ('gitlab-api'),
});

/** @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} control */
const withActionSignal = (control) => {
  const signal = control.signal || getCommandActionSignal();
  return signal && signal !== control.signal ? { ...control, signal } : control;
};

/** @param {{path: string, ref: string}} request */
const fileBlobRequestKey = (request) => `${request.ref}:${request.path}`;

/**
 * Resolve immutable ref+path coordinates from native Git in one bounded batch.
 * @param {string} repoRoot
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project
 * @param {ReadonlyArray<{maxBytes: number, path: string, ref: string, signal?: AbortSignal}>} requests
 */
const readNativeFileBlobArtifacts = async (repoRoot, project, requests) => {
  const signal =
    requests.find((request) => request.signal)?.signal ||
    getCommandActionSignal() ||
    new AbortController().signal;
  const coordinates = requests.map(({ maxBytes, path, ref }) => ({ maxBytes, path, ref }));
  const maxBytes = Math.max(0, ...coordinates.map((request) => request.maxBytes));
  return createNativeCommitArtifactSource(repoRoot, project, {
    maxBlobArtifactBytes: maxBytes,
  }).readFileBlobs(coordinates, signal);
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
  const signal =
    requests.find((request) => request.signal)?.signal ||
    getCommandActionSignal() ||
    new AbortController().signal;
  const coordinates = requests.map(({ maxBytes, path, ref }) => ({ maxBytes, path, ref }));
  const project = githubArtifactProject(pull);
  const maxBytes = Math.max(0, ...coordinates.map((request) => request.maxBytes));
  let local = new Map();
  try {
    local = await readNativeFileBlobArtifacts(
      repoRoot,
      project,
      coordinates.map((coordinate) => ({ ...coordinate, signal })),
    );
  } catch {
    signal.throwIfAborted();
  }
  const missing = coordinates.filter((coordinate) => !local.has(fileBlobRequestKey(coordinate)));
  if (missing.length === 0) return local;
  const source = (await loadGitHubHistory()).createGitHubArtifactSource({
    maxBlobArtifactBytes: maxBytes,
    project,
    pull: { ...pull, number: pull.number || 0 },
    transport: transport || createGhGitHubTransport({ repoRoot }),
  });
  const provider = (await source.readFileBlobs?.(missing, signal)) || new Map();
  return new Map([...local, ...provider]);
};

/** @param {string} repoRoot @param {{host?: string, number?: number, owner: string, repo: string}} pull @param {{maxBytes: number, path: string, ref: string, signal?: AbortSignal}} request @param {ReturnType<typeof createGhGitHubTransport>} [transport] */
const readGitHubFileBlobArtifact = async (repoRoot, pull, request, transport) =>
  (await readGitHubFileBlobArtifacts(repoRoot, pull, [request], transport)).get(
    fileBlobRequestKey(request),
  );

/**
 * Resolve GitLab ref+path coordinates through native Git first and the
 * canonical API Artifact Source second. Returned bytes carry Git object IDs.
 * @param {string} repoRoot
 * @param {{host: string, projectPath: string}} mergeRequest
 * @param {ReadonlyArray<{maxBytes: number, path: string, ref: string, signal?: AbortSignal}>} requests
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readGitLabFileBlobArtifacts = async (repoRoot, mergeRequest, requests, transport) => {
  const signal =
    requests.find((request) => request.signal)?.signal ||
    getCommandActionSignal() ||
    new AbortController().signal;
  const coordinates = requests.map(({ maxBytes, path, ref }) => ({ maxBytes, path, ref }));
  const project = gitlabArtifactProject(mergeRequest);
  const maxBytes = Math.max(0, ...coordinates.map((request) => request.maxBytes));
  let local = new Map();
  try {
    local = await readNativeFileBlobArtifacts(
      repoRoot,
      project,
      coordinates.map((coordinate) => ({ ...coordinate, signal })),
    );
  } catch {
    signal.throwIfAborted();
  }
  const missing = coordinates.filter((coordinate) => !local.has(fileBlobRequestKey(coordinate)));
  if (missing.length === 0) return local;
  const source = (await loadGitLabHistory()).createGitLabArtifactSource({
    maxBlobArtifactBytes: maxBytes,
    project,
    projectPath: mergeRequest.projectPath,
    transport: transport || createGlabGitLabTransport({ hostname: mergeRequest.host, repoRoot }),
  });
  const provider = (await source.readFileBlobs?.(missing, signal)) || new Map();
  return new Map([...local, ...provider]);
};

/** @param {string} repoRoot @param {{host: string, projectPath: string}} mergeRequest @param {{maxBytes: number, path: string, ref: string, signal?: AbortSignal}} request @param {ReturnType<typeof createGlabGitLabTransport>} [transport] */
const readGitLabFileBlobArtifact = async (repoRoot, mergeRequest, request, transport) =>
  (await readGitLabFileBlobArtifacts(repoRoot, mergeRequest, [request], transport)).get(
    fileBlobRequestKey(request),
  );

/**
 * Prefer bounded native Git and route only unavailable or incomplete keys to
 * the canonical GitHub API Artifact Source.
 * @param {string} repoRoot
 * @param {{host?: string, number: number, owner: string, repo: string}} pull
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 */
const getGitHubComparisonArtifactRun = (repoRoot, pull, control = {}, transport) =>
  getComparisonArtifactRun(repoRoot, githubArtifactProject(pull), withActionSignal(control), {
    fallbackSource: createGitHubArtifactBackend(repoRoot, pull, transport),
  });

/**
 * Acquire an explicit GitHub range through its canonical API source. This is
 * used before local review refs are available and populates the provider cache
 * consumed by later hybrid Comparison Runs.
 * @param {string} repoRoot
 * @param {{host?: string, number: number, owner: string, repo: string}} pull
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 */
const getGitHubProviderArtifactRun = (repoRoot, pull, control = {}, transport) =>
  getComparisonArtifactRun(repoRoot, githubArtifactProject(pull), withActionSignal(control), {
    source: createGitHubArtifactBackend(repoRoot, pull, transport),
  });

/**
 * Prefer bounded native Git and route only unavailable or incomplete keys to
 * the canonical GitLab API Artifact Source.
 * @param {string} repoRoot
 * @param {{host: string, projectPath: string}} mergeRequest
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const getGitLabComparisonArtifactRun = (repoRoot, mergeRequest, control = {}, transport) =>
  getComparisonArtifactRun(
    repoRoot,
    gitlabArtifactProject(mergeRequest),
    withActionSignal(control),
    { fallbackSource: createGitLabArtifactBackend(repoRoot, mergeRequest, transport) },
  );

/**
 * Acquire an explicit GitLab range through its canonical API source. This is
 * used before local review refs are available and populates the provider cache
 * consumed by later hybrid Comparison Runs.
 * @param {string} repoRoot
 * @param {{host: string, projectPath: string}} mergeRequest
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const getGitLabProviderArtifactRun = (repoRoot, mergeRequest, control = {}, transport) =>
  getComparisonArtifactRun(
    repoRoot,
    gitlabArtifactProject(mergeRequest),
    withActionSignal(control),
    { source: createGitLabArtifactBackend(repoRoot, mergeRequest, transport) },
  );

module.exports = {
  createGitHubArtifactBackend,
  createGitLabArtifactBackend,
  getGitHubComparisonArtifactRun,
  getGitHubProviderArtifactRun,
  getGitLabComparisonArtifactRun,
  getGitLabProviderArtifactRun,
  githubArtifactProject,
  githubRangeDiffSemantics,
  gitlabArtifactProject,
  gitlabRangeDiffSemantics,
  readGitHubFileBlobArtifact,
  readGitHubFileBlobArtifacts,
  readGitLabFileBlobArtifact,
  readGitLabFileBlobArtifacts,
  readNativeFileBlobArtifacts,
};
