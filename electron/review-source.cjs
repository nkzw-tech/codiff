// @ts-check

const { execFileSync, spawn } = require('node:child_process');

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

/**
 * Run a command and return its trimmed stdout, or an empty string when it is
 * not installed, errors, or exceeds the timeout. Never throws so base-branch
 * resolution can always fall back gracefully.
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {string} cwd
 */
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

/**
 * Best-effort default branch for a remote: the remote's `HEAD` symbolic ref,
 * then `main`/`master` if either is tracked, then `main`.
 * @param {string} repositoryPath
 * @param {string} remoteName
 */
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

  for (const candidate of ['main', 'master']) {
    if (
      tryCommandOutput(
        'git',
        ['show-ref', '--verify', `refs/remotes/${remoteName}/${candidate}`],
        repositoryPath,
      )
    ) {
      return candidate;
    }
  }

  return 'main';
};

/**
 * Resolve the branch the current branch's open pull/merge request targets so a
 * review can diff against the real base of a stack instead of always against
 * `main`. Asks GitHub through `gh` or GitLab through `glab` (chosen from the
 * repository's primary review remote) and falls back to the remote's default
 * branch when there is no request or the CLI is unavailable.
 * @param {string} repositoryPath
 * @returns {{ base: string; provider: ReviewProvider; ref: string; remote: string }}
 */
const resolveBaseBranchRef = (repositoryPath) => {
  let remotes = [];
  try {
    remotes = readReviewRemotes(repositoryPath);
  } catch {
    remotes = [];
  }

  const remote = remotes.sort((left, right) => remotePriority(left) - remotePriority(right))[0];
  const remoteName = remote?.name ?? 'origin';
  const provider = remote?.provider ?? /** @type {ReviewProvider} */ ('github');

  const base =
    (provider === 'gitlab'
      ? tryCommandOutput(
          'glab',
          ['mr', 'view', '--output', 'json', '--jq', '.target_branch'],
          repositoryPath,
        )
      : tryCommandOutput(
          'gh',
          ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'],
          repositoryPath,
        )) || resolveDefaultRemoteBranch(repositoryPath, remoteName);

  return { base, provider, ref: `${remoteName}/${base}`, remote: remoteName };
};

/**
 * Refresh a single base branch from its remote. Blocks only when the ref is
 * not present locally yet so the diff has something to compare against;
 * otherwise it refreshes in the background and returns immediately, mirroring
 * the parallel fetch in the `cdf` shell helper this command is based on.
 * @param {string} repositoryPath
 * @param {string} remoteName
 * @param {string} base
 */
const refreshBaseBranchRef = (repositoryPath, remoteName, base) => {
  const hasRef = Boolean(
    tryCommandOutput(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteName}/${base}^{commit}`],
      repositoryPath,
    ),
  );
  const fetchArgs = ['-C', repositoryPath, 'fetch', remoteName, base, '--quiet'];

  if (hasRef) {
    try {
      const child = spawn('git', fetchArgs, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    } catch {
      // A failed background refresh still leaves the existing ref to diff against.
    }
    return;
  }

  try {
    execFileSync('git', fetchArgs, { stdio: 'ignore', timeout: 30_000 });
  } catch {
    // Offline or unknown branch: fall through and let the diff report what it can.
  }
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
  refreshBaseBranchRef,
  resolveBaseBranchRef,
  resolveReviewUrl,
};
