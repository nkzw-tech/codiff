// @ts-check

const { execFileSync } = require('node:child_process');

/** @typedef {'github' | 'gitlab'} ReviewProvider */

// Reviews are usually pasted straight from a browser, so anything after the review number is a tab
// (`/files`, `/changes`, `/diffs`), a query, or an anchor, and none of it identifies the review.
const gitHubPullRequestPattern = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/;
const gitLabMergeRequestPattern = /^\/(.+?)\/-\/merge_requests\/([1-9]\d*)(?:\/.*)?$/;
// GitLab only introduced the `/-/` separator in 11.0; older instances and links still omit it.
const legacyGitLabMergeRequestPattern = /^\/(.+?)\/merge_requests\/([1-9]\d*)(?:\/.*)?$/;
const markdownAutolinkPattern = /^<(.+)>$/;
const schemePattern = /^[A-Za-z][A-Za-z\d+.-]*:/;
// A scheme-less paste only counts as a URL when it starts with something host-shaped, so relative
// paths and refs are never mistaken for links.
const hostPrefixPattern = /^[^/\s:@]+\.[^/\s:@]+(?::\d+)?\//;

/** @param {string} value */
const stripGitSuffix = (value) => value.replace(/\.git$/i, '');

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

/** @param {URL} url */
const isGitHubHost = (url) => {
  const hostname = url.hostname.toLowerCase();
  return hostname === 'github.com' || hostname === 'www.github.com';
};

/** @param {string} value */
const parseReviewUrl = (value) => {
  const url = toReviewUrl(value);
  if (!url) {
    return null;
  }

  const github = isGitHubHost(url) ? url.pathname.match(gitHubPullRequestPattern) : null;
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
  const scp = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !trimmed.includes('://') && !/^[A-Za-z]:/.test(trimmed)) {
    const projectPath = scp[2].replaceAll(/^\/+|\.git$/gi, '');
    return projectPath
      ? {
          host: scp[1].toLowerCase(),
          projectPath,
          provider: /** @type {ReviewProvider} */ (
            scp[1].toLowerCase() === 'github.com' ? 'github' : 'gitlab'
          ),
        }
      : null;
  }

  try {
    const url = new URL(trimmed);
    const projectPath = url.pathname.replaceAll(/^\/+|\.git$/gi, '');
    return projectPath
      ? {
          // A custom SSH port (`ssh://git@host:2222/...`) is transport detail, not part
          // of the instance identifier, and glab's `--hostname` rejects `host:port` —
          // strip it. An explicit port on `https://` remotes stays: it identifies the instance.
          host: (url.protocol === 'ssh:' ? url.hostname : url.host).toLowerCase(),
          projectPath,
          provider: /** @type {ReviewProvider} */ (
            url.hostname.toLowerCase() === 'github.com' ? 'github' : 'gitlab'
          ),
        }
      : null;
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
    .filter((candidate) => !provider || candidate.provider === provider)
    .sort((left, right) => remotePriority(left) - remotePriority(right))[0];
  if (!remote) {
    throw new Error(
      `Could not resolve ${provider === 'gitlab' ? 'MR' : provider === 'github' ? 'PR' : 'review'} #${number} from this repository's remotes.`,
    );
  }

  return remote.provider === 'github'
    ? `https://github.com/${remote.projectPath}/pull/${number}`
    : `https://${remote.host}/${remote.projectPath}/-/merge_requests/${number}`;
};

module.exports = {
  parseRemoteUrl,
  parseReviewUrl,
  readReviewRemotes,
  resolveReviewUrl,
};
