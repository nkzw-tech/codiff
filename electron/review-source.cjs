// @ts-check

const { execFileSync } = require('node:child_process');

/** @typedef {'github' | 'gitlab' | 'azure-devops'} ReviewProvider */

// Reviews are usually pasted straight from a browser, so anything after the review number is a tab
// (`/files`, `/changes`, `/diffs`), a query, or an anchor, and none of it identifies the review.
const gitHubPullRequestPattern = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/;
const gitLabMergeRequestPattern = /^\/(.+?)\/-\/merge_requests\/([1-9]\d*)(?:\/.*)?$/;
// GitLab only introduced the `/-/` separator in 11.0; older instances and links still omit it.
const legacyGitLabMergeRequestPattern = /^\/(.+?)\/merge_requests\/([1-9]\d*)(?:\/.*)?$/;
const azureDevOpsPullRequestPattern =
  /^\/(.+?)\/_git\/([^/]+)\/pullrequests?\/([1-9]\d*)(?:\/.*)?$/i;
const azureDevOpsGitRemotePattern = /^(.+)\/_git\/([^/]+)$/i;
const azureDevOpsSshRemotePattern = /^v3\/([^/]+)\/(.+)\/([^/]+)$/i;
const markdownAutolinkPattern = /^<(.+)>$/;
const schemePattern = /^[A-Za-z][A-Za-z\d+.-]*:/;
// A scheme-less paste only counts as a URL when it starts with something host-shaped, so relative
// paths and refs are never mistaken for links.
const hostPrefixPattern = /^[^/\s:@]+\.[^/\s:@]+(?::\d+)?\//;

/** @param {string} value */
const stripGitSuffix = (value) => value.replace(/\.git$/i, '');

/** @param {string} value */
const decodePathSegment = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** @param {string} hostname */
const isGitHubHost = (hostname) => {
  const normalized = hostname.toLowerCase();
  return normalized === 'github.com' || normalized === 'www.github.com';
};

/** @param {string} hostname */
const isAzureDevOpsSshHost = (hostname) => {
  const normalized = hostname.toLowerCase();
  return normalized === 'ssh.dev.azure.com' || normalized === 'vs-ssh.visualstudio.com';
};

/** @param {string} hostname */
const isAzureDevOpsWebHost = (hostname) => {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'dev.azure.com' ||
    normalized === 'www.dev.azure.com' ||
    normalized.endsWith('.visualstudio.com')
  );
};

/** @param {string} hostname */
const isAzureDevOpsHost = (hostname) =>
  isAzureDevOpsWebHost(hostname) || isAzureDevOpsSshHost(hostname);

/**
 * @param {string} hostname
 * @param {string} organization
 */
const getAzureDevOpsWebHost = (hostname, organization) => {
  const normalized = hostname.toLowerCase().replace(/^www\./, '');
  if (normalized === 'vs-ssh.visualstudio.com' || normalized === 'visualstudio.com') {
    return `${organization}.visualstudio.com`;
  }
  if (normalized.endsWith('.visualstudio.com')) {
    return normalized;
  }
  if (
    normalized === 'dev.azure.com' ||
    normalized === 'ssh.dev.azure.com' ||
    normalized.endsWith('.dev.azure.com')
  ) {
    return 'dev.azure.com';
  }
  return normalized;
};

/** @param {string} value */
const encodePath = (value) => value.split('/').map(encodeURIComponent).join('/');

/**
 * @param {string} webHost
 * @param {string} organization
 * @param {string} project
 * @param {string} repo
 * @param {number} [number]
 */
const formatAzureDevOpsUrl = (webHost, organization, project, repo, number) => {
  const encodedProject = encodePath(project);
  const encodedRepo = encodeURIComponent(repo);
  const suffix = number == null ? '' : `/pullrequest/${number}`;
  if (webHost.endsWith('.visualstudio.com')) {
    return `https://${webHost}/${encodedProject}/_git/${encodedRepo}${suffix}`;
  }
  return `https://${webHost}/${encodePath(organization)}/${encodedProject}/_git/${encodedRepo}${suffix}`;
};

/**
 * @param {string} webHost
 * @param {string} organization
 * @param {string} project
 */
const getAzureDevOpsOrganizationUrl = (webHost, organization) =>
  webHost.endsWith('.visualstudio.com')
    ? `https://${webHost}`
    : `https://${webHost}/${encodePath(organization)}`;

/**
 * @param {string} webHost
 * @param {string} organization
 * @param {string} project
 */
const getAzureDevOpsApiBase = (webHost, organization, project) =>
  `${getAzureDevOpsOrganizationUrl(webHost, organization)}/${encodePath(project)}`;

/**
 * @param {string} hostname
 * @param {string} projectPath
 * @returns {{
 *   apiBase: string;
 *   host: string;
 *   organization: string;
 *   organizationUrl: string;
 *   project: string;
 *   projectPath: string;
 *   provider: 'azure-devops';
 *   repo: string;
 *   webHost: string;
 * } | null}
 */
const parseAzureDevOpsRemote = (hostname, projectPath) => {
  const host = hostname.toLowerCase();
  const path = stripGitSuffix(projectPath).replace(/^\/+/, '');
  const sshMatch = isAzureDevOpsSshHost(host) ? path.match(azureDevOpsSshRemotePattern) : null;
  if (sshMatch) {
    const organization = decodePathSegment(sshMatch[1]);
    const project = decodePathSegment(sshMatch[2]);
    const repo = decodePathSegment(sshMatch[3]);
    const webHost = getAzureDevOpsWebHost(host, organization);
    return {
      apiBase: getAzureDevOpsApiBase(webHost, organization, project),
      host,
      organization,
      organizationUrl: getAzureDevOpsOrganizationUrl(webHost, organization),
      project,
      projectPath: `${organization}/${project}/${repo}`,
      provider: /** @type {const} */ ('azure-devops'),
      repo,
      webHost,
    };
  }

  const gitMatch = path.match(azureDevOpsGitRemotePattern);
  if (!gitMatch) {
    return null;
  }
  if (!isAzureDevOpsHost(host) && !path.includes('/_git/')) {
    return null;
  }

  const rawPrefix = gitMatch[1].split('/').map(decodePathSegment).filter(Boolean);
  const visualStudioCloud = host.endsWith('.visualstudio.com');
  const prefix = visualStudioCloud
    ? rawPrefix.filter((segment) => segment.toLowerCase() !== 'defaultcollection')
    : rawPrefix;
  const repo = decodePathSegment(gitMatch[2]);
  let organization;
  let project;
  if (host === 'dev.azure.com' || host === 'www.dev.azure.com' || host === 'ssh.dev.azure.com') {
    organization = prefix[0] || '';
    project = prefix.slice(1).join('/') || repo;
  } else if (visualStudioCloud) {
    organization =
      host === 'vs-ssh.visualstudio.com' || host === 'visualstudio.com'
        ? prefix[0] || ''
        : host.replace(/\.visualstudio\.com$/i, '').replace(/^www\./, '');
    project = (host === 'vs-ssh.visualstudio.com' ? prefix.slice(1) : prefix).join('/') || repo;
  } else {
    organization = prefix[0] || host;
    project = prefix.slice(1).join('/') || prefix[0] || repo;
  }
  if (!organization || !project || !repo) {
    return null;
  }

  const webHost = getAzureDevOpsWebHost(host, organization);
  return {
    apiBase: getAzureDevOpsApiBase(webHost, organization, project),
    host,
    organization,
    organizationUrl: getAzureDevOpsOrganizationUrl(webHost, organization),
    project,
    projectPath: `${organization}/${project}/${repo}`,
    provider: /** @type {const} */ ('azure-devops'),
    repo,
    webHost,
  };
};

/** @param {string} value */
const toReviewUrl = (value) => {
  const trimmed = value.trim();
  const unwrapped = trimmed.match(markdownAutolinkPattern)?.[1] ?? trimmed;
  const candidate = schemePattern.test(unwrapped)
    ? unwrapped
    : hostPrefixPattern.test(unwrapped)
      ? `https://${unwrapped}`
      : null;
  if (!candidate) {
    return null;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
};

/** @param {string} value */
const parseReviewUrl = (value) => {
  const url = toReviewUrl(value);
  if (!url) {
    return null;
  }

  const github = isGitHubHost(url.hostname) ? url.pathname.match(gitHubPullRequestPattern) : null;
  const repo = github ? stripGitSuffix(github[2]) : '';
  if (github && repo) {
    return {
      host: 'github.com',
      number: Number(github[3]),
      owner: github[1],
      projectPath: `${github[1]}/${repo}`,
      provider: /** @type {const} */ ('github'),
      repo,
      url: `https://github.com/${github[1]}/${repo}/pull/${github[3]}`,
    };
  }

  const azurePath = url.pathname.match(azureDevOpsPullRequestPattern);
  const azureRemote = azurePath
    ? parseAzureDevOpsRemote(url.hostname, `${azurePath[1]}/_git/${azurePath[2]}`)
    : null;
  if (azureRemote) {
    const number = Number(azurePath[3]);
    return {
      ...azureRemote,
      host: azureRemote.webHost,
      number,
      url: formatAzureDevOpsUrl(
        azureRemote.webHost,
        azureRemote.organization,
        azureRemote.project,
        azureRemote.repo,
        number,
      ),
    };
  }

  const gitlab =
    url.pathname.match(gitLabMergeRequestPattern) ??
    url.pathname.match(legacyGitLabMergeRequestPattern);
  const projectPath = gitlab ? stripGitSuffix(gitlab[1]) : '';
  if (gitlab && projectPath) {
    return {
      host: url.host.toLowerCase(),
      number: Number(gitlab[2]),
      projectPath,
      provider: /** @type {const} */ ('gitlab'),
      url: `${url.protocol}//${url.host}/${projectPath}/-/merge_requests/${gitlab[2]}`,
    };
  }

  return null;
};

/** @param {string} value */
const parseRemoteUrl = (value) => {
  const trimmed = value.trim();
  const scp = trimmed.match(/^(?:[^@/\s]+@)*([^@/\s:]+):(.+)$/);
  if (scp && !trimmed.includes('://') && !/^[A-Za-z]:/.test(trimmed)) {
    const host = scp[1].toLowerCase();
    const projectPath = scp[2].replaceAll(/^\/+|\.git$/gi, '');
    if (!projectPath) {
      return null;
    }
    const azure = parseAzureDevOpsRemote(host, projectPath);
    if (azure) {
      return azure;
    }
    return {
      host,
      projectPath,
      provider: /** @type {ReviewProvider} */ (isGitHubHost(host) ? 'github' : 'gitlab'),
    };
  }

  try {
    const url = new URL(trimmed);
    const host = url.host.toLowerCase();
    const projectPath = url.pathname.replaceAll(/^\/+|\.git$/gi, '');
    if (!projectPath) {
      return null;
    }
    const azure = parseAzureDevOpsRemote(url.hostname, projectPath);
    if (azure) {
      return azure;
    }
    return {
      host,
      projectPath,
      provider: /** @type {ReviewProvider} */ (isGitHubHost(url.hostname) ? 'github' : 'gitlab'),
    };
  } catch {
    return null;
  }
};

/** @param {string} repositoryPath */
const readReviewRemotes = (repositoryPath) => {
  const root = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const raw = execFileSync('git', ['-C', root, 'remote', '-v'], { encoding: 'utf8' });
  const remotes = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    const remote = match ? parseRemoteUrl(match[2]) : null;
    if (match && remote) {
      remotes.push({ direction: match[3], name: match[1], ...remote });
    }
  }
  return remotes;
};

/** @param {{direction: string; name: string}} remote */
const remotePriority = (remote) =>
  remote.name === 'origin'
    ? remote.direction === 'fetch'
      ? 0
      : 1
    : remote.direction === 'fetch'
      ? 2
      : 3;

/**
 * `codiff pr` is GitHub-first, but Azure DevOps also calls them pull requests.
 * Prefer a GitHub remote when both exist; otherwise use the Azure remote.
 *
 * @param {ReviewProvider | undefined} provider
 * @param {{provider: ReviewProvider}} remote
 */
const remoteMatchesProvider = (provider, remote) =>
  !provider ||
  remote.provider === provider ||
  (provider === 'github' && remote.provider === 'azure-devops');

/**
 * @param {ReviewProvider | undefined} provider
 * @param {{provider: ReviewProvider}} left
 * @param {{provider: ReviewProvider}} right
 */
const providerPriority = (provider, left, right) => {
  if (provider !== 'github') {
    return 0;
  }
  return (left.provider === 'github' ? 0 : 1) - (right.provider === 'github' ? 0 : 1);
};

/**
 * @param {string} repositoryPath
 * @param {number} number
 * @param {ReviewProvider | undefined} provider
 */
const resolveReviewUrl = (repositoryPath, number, provider) => {
  let remotes;
  try {
    remotes = readReviewRemotes(repositoryPath);
  } catch {
    throw new Error(
      `Could not resolve review #${number}. Run codiff inside a Git repository or pass a full pull/merge request URL.`,
    );
  }

  const remote = remotes
    .filter((candidate) => remoteMatchesProvider(provider, candidate))
    .sort(
      (left, right) =>
        providerPriority(provider, left, right) || remotePriority(left) - remotePriority(right),
    )[0];
  if (!remote) {
    throw new Error(
      `Could not resolve ${
        provider === 'gitlab'
          ? 'MR'
          : provider === 'azure-devops'
            ? 'Azure DevOps PR'
            : provider === 'github'
              ? 'PR'
              : 'review'
      } #${number} from this repository's remotes.`,
    );
  }

  if (remote.provider === 'github') {
    return `https://github.com/${remote.projectPath}/pull/${number}`;
  }
  if (remote.provider === 'azure-devops') {
    return formatAzureDevOpsUrl(
      remote.webHost,
      remote.organization,
      remote.project,
      remote.repo,
      number,
    );
  }
  return `https://${remote.host}/${remote.projectPath}/-/merge_requests/${number}`;
};

module.exports = {
  parseRemoteUrl,
  parseReviewUrl,
  readReviewRemotes,
  resolveReviewUrl,
};
