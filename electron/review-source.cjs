// @ts-check

const { execFileSync } = require('node:child_process');

/** @typedef {'github' | 'gitlab'} ReviewProvider */

/** @param {string} value */
const parseReviewUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const host = url.host.toLowerCase();
  const github = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if (url.hostname.toLowerCase() === 'github.com' && github) {
    return {
      host,
      number: Number(github[3]),
      owner: github[1],
      projectPath: `${github[1]}/${github[2]}`,
      provider: /** @type {const} */ ('github'),
      repo: github[2],
      url: `https://github.com/${github[1]}/${github[2]}/pull/${github[3]}`,
    };
  }

  const gitlab = url.pathname.match(/^\/(.+?)\/-\/merge_requests\/([1-9]\d*)\/?$/);
  if (gitlab) {
    return {
      host,
      number: Number(gitlab[2]),
      projectPath: gitlab[1].replace(/\.git$/i, ''),
      provider: /** @type {const} */ ('gitlab'),
      url: `${url.protocol}//${url.host}/${gitlab[1].replace(/\.git$/i, '')}/-/merge_requests/${
        gitlab[2]
      }`,
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
          host: url.host.toLowerCase(),
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

const tryCommandOutput = (command, args, cwd) => {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trim();
  } catch {
    return '';
  }
};

/** @param {string} repositoryPath */
const getPrimaryReviewRemote = (repositoryPath) =>
  readReviewRemotes(repositoryPath).sort(
    (left, right) => remotePriority(left) - remotePriority(right),
  )[0];

/** @param {string} repositoryPath @param {string} remoteName */
const resolveDefaultRemoteBranch = (repositoryPath, remoteName) => {
  const head = tryCommandOutput(
    'git',
    ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`],
    repositoryPath,
  );
  const prefix = `${remoteName}/`;
  if (head.startsWith(prefix)) {
    return head.slice(prefix.length);
  }

  return 'main';
};

/**
 * @param {string} repositoryPath
 * @returns {{ base: string; ref: string; remote: string }}
 */
const resolveBaseBranchRef = (repositoryPath) => {
  const remote = getPrimaryReviewRemote(repositoryPath);
  const remoteName = remote.name;
  const base =
    remote.provider === 'gitlab'
      ? tryCommandOutput(
          'glab',
          ['mr', 'view', '--output', 'json', '--jq', '.target_branch'],
          repositoryPath,
        )
      : tryCommandOutput(
          'gh',
          ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'],
          repositoryPath,
        );

  const branch = base || resolveDefaultRemoteBranch(repositoryPath, remoteName);
  return { base: branch, ref: `${remoteName}/${branch}`, remote: remoteName };
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
  resolveBaseBranchRef,
  resolveReviewUrl,
};
