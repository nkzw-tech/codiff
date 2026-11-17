// @ts-check

const { promises: fs } = require('node:fs');
const { join, sep } = require('node:path');
const { getFingerprint, git } = require('./git-state/common.cjs');

const FOCUSED_POLL_INTERVAL = 2500;
const HIDDEN_POLL_INTERVAL = 30_000;
const SELF_WRITE_CHECK_DELAY = 250;
const VISIBLE_POLL_INTERVAL = 10_000;

/** @param {string} path @param {string} [pathSeparator] */
const normalizeRepositoryWatcherPath = (path, pathSeparator = sep) =>
  pathSeparator === '\\' ? path.replaceAll('\\', '/') : path;

/** @param {string} record @param {number} count */
const readStatusPath = (record, count) => {
  let index = 0;
  for (let field = 0; field < count; field += 1) {
    index = record.indexOf(' ', index);
    if (index === -1) {
      return '';
    }
    index += 1;
  }
  return record.slice(index);
};

/** @param {string} raw */
const parseRepositoryWatcherStatus = (raw) => {
  let branchHead = '';
  let branchOid = '';
  /** @type {Set<string>} */
  const paths = new Set();
  const records = raw.split('\0').filter(Boolean);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('# branch.oid ')) {
      branchOid = record.slice('# branch.oid '.length);
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      branchHead = record.slice('# branch.head '.length);
      continue;
    }
    if (record.startsWith('? ')) {
      paths.add(record.slice(2));
      continue;
    }
    if (record.startsWith('1 ')) {
      paths.add(readStatusPath(record, 8));
      continue;
    }
    if (record.startsWith('2 ')) {
      paths.add(readStatusPath(record, 9));
      const oldPath = records[++index];
      if (oldPath) {
        paths.add(oldPath);
      }
      continue;
    }
    if (record.startsWith('u ')) {
      paths.add(readStatusPath(record, 10));
    }
  }

  return {
    head: `${branchOid}\0${branchHead}`,
    paths: [...paths],
  };
};

/**
 * @param {string} repoRoot
 * @param {string} path
 * @param {boolean} exact
 */
const readRepositoryWatcherPathState = async (repoRoot, path, exact) => {
  try {
    const absolutePath = join(repoRoot, path);
    const stat = await fs.lstat(absolutePath);
    const metadata = `${path}\0${
      stat.isDirectory()
        ? 'directory'
        : stat.isSymbolicLink()
          ? 'symlink'
          : stat.isFile()
            ? 'file'
            : 'other'
    }\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`;
    if (!exact) {
      return { metadata };
    }

    const version = stat.isSymbolicLink()
      ? getFingerprint(await fs.readlink(absolutePath))
      : stat.isFile()
        ? getFingerprint(await fs.readFile(absolutePath))
        : undefined;
    return { metadata, version };
  } catch {
    return { metadata: `${path}\0missing` };
  }
};

/**
 * Read a repository watcher snapshot with one Git process. `repoRoot` must
 * already be the repository root.
 *
 * @param {string} repoRoot
 * @param {Iterable<string>} [exactPaths]
 * @param {Iterable<string>} [knownDirtyPaths]
 */
const readRepositoryWatcherSnapshot = async (repoRoot, exactPaths = [], knownDirtyPaths = []) => {
  const knownDirtyPathSet = new Set(knownDirtyPaths);
  // Polling must not take `index.lock`, or a concurrent Git command in the
  // user's terminal fails with "Unable to create index.lock".
  const statusArgs = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '-uall'];
  // Git status hashes modified tracked files. Known dirty paths are monitored
  // through metadata instead, while this command discovers all new changes.
  if (knownDirtyPathSet.size > 0) {
    statusArgs.push(
      '--',
      '.',
      ...[...knownDirtyPathSet].map((path) => `:(exclude,literal)${path}`),
    );
  }
  const status = parseRepositoryWatcherStatus(await git(repoRoot, statusArgs));
  const normalizedExactPaths = new Set(
    [...exactPaths].map((path) => normalizeRepositoryWatcherPath(path)),
  );
  const statusPaths = new Set([...status.paths, ...knownDirtyPathSet]);
  const paths = new Set([...statusPaths, ...normalizedExactPaths]);
  const states = await Promise.all(
    [...paths].map(async (path) => [
      path,
      await readRepositoryWatcherPathState(repoRoot, path, normalizedExactPaths.has(path)),
    ]),
  );
  /** @type {Record<string, string>} */
  const pathSignatures = {};
  /** @type {Record<string, string>} */
  const pathVersions = {};

  for (const [path, state] of states) {
    if (statusPaths.has(path)) {
      pathSignatures[path] = state.metadata;
    }
    if (state.version) {
      pathVersions[path] = state.version;
    }
  }

  const sortedSignatures = Object.entries(pathSignatures).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return {
    head: status.head,
    pathSignatures: Object.fromEntries(sortedSignatures),
    pathVersions,
    root: repoRoot,
    signature: getFingerprint(
      [status.head, ...sortedSignatures.map(([, signature]) => signature)].join('\0'),
    ),
  };
};

/** @param {string} launchPath @param {Iterable<string>} [exactPaths] */
const readRepositoryChangeSignature = async (launchPath, exactPaths = []) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  return readRepositoryWatcherSnapshot(repoRoot, exactPaths);
};

/**
 * @param {{head: string; pathSignatures: Record<string, string>}} left
 * @param {{head: string; pathSignatures: Record<string, string>; pathVersions?: Record<string, string>}} right
 * @param {ReadonlyMap<string, string>} expectedPathVersions
 */
const repositoryWatcherSnapshotsMatchExpectedWrites = (left, right, expectedPathVersions) => {
  if (left.head !== right.head) {
    return false;
  }

  for (const [path, version] of expectedPathVersions) {
    if (right.pathVersions?.[path] !== version.slice(0, 16)) {
      return false;
    }
  }

  const paths = new Set([
    ...Object.keys(left.pathSignatures),
    ...Object.keys(right.pathSignatures),
  ]);
  for (const path of paths) {
    if (
      !expectedPathVersions.has(normalizeRepositoryWatcherPath(path)) &&
      left.pathSignatures[path] !== right.pathSignatures[path]
    ) {
      return false;
    }
  }

  return true;
};

/** @param {ReadonlyArray<{focused: boolean; visible: boolean}>} states */
const getRepositoryWatcherPollInterval = (states) => {
  if (states.some(({ focused }) => focused)) {
    return FOCUSED_POLL_INTERVAL;
  }
  if (states.some(({ visible }) => visible)) {
    return VISIBLE_POLL_INTERVAL;
  }
  return HIDDEN_POLL_INTERVAL;
};

/**
 * @param {{
 *   clearTimeoutImpl?: typeof clearTimeout;
 *   readSnapshot: (root: string, exactPaths: Iterable<string>, knownDirtyPaths: Iterable<string>) => Promise<{head: string; pathSignatures: Record<string, string>; pathVersions?: Record<string, string>; root: string; signature: string}>;
 *   setTimeoutImpl?: typeof setTimeout;
 * }} options
 */
const createRepositoryWatcherCoordinator = ({
  clearTimeoutImpl = clearTimeout,
  readSnapshot,
  setTimeoutImpl = setTimeout,
}) => {
  /**
   * @typedef {{
   *   checking: boolean;
   *   pendingSelfWrites: Map<string, {completed: boolean; generation: number; ownerId: number; version?: string}>;
   *   recheckRequested: boolean;
   *   resetRequested: Set<number>;
   *   root: string;
   *   snapshot?: Awaited<ReturnType<typeof readSnapshot>>;
   *   subscribers: Map<number, {changed: boolean; getState: () => {focused: boolean; visible: boolean}; notify: (root: string) => void; snapshot?: Awaited<ReturnType<typeof readSnapshot>>}>;
   *   timer?: ReturnType<typeof setTimeout>;
   * }} RepositoryWatcher
   */
  /** @type {Map<string, RepositoryWatcher>} */
  const watchers = new Map();
  /** @type {Map<number, string>} */
  const subscriberRoots = new Map();

  /** @param {RepositoryWatcher} watcher */
  const clearTimer = (watcher) => {
    if (watcher.timer) {
      clearTimeoutImpl(watcher.timer);
      watcher.timer = undefined;
    }
  };

  /** @param {RepositoryWatcher} watcher */
  const getPollInterval = (watcher) =>
    getRepositoryWatcherPollInterval(
      [...watcher.subscribers.values()]
        .filter(({ changed }) => !changed)
        .map(({ getState }) => {
          try {
            return getState();
          } catch {
            return { focused: false, visible: false };
          }
        }),
    );

  /**
   * @param {RepositoryWatcher} watcher
   * @param {number} delay
   */
  const schedule = (watcher, delay) => {
    clearTimer(watcher);
    watcher.timer = setTimeoutImpl(() => {
      watcher.timer = undefined;
      void check(watcher);
    }, delay);
  };

  /** @param {RepositoryWatcher} watcher */
  const schedulePoll = (watcher) => {
    if ([...watcher.subscribers.values()].some(({ changed }) => !changed)) {
      schedule(watcher, getPollInterval(watcher));
    }
  };

  /**
   * @param {RepositoryWatcher} watcher
   * @param {Iterable<number>} [resetIds]
   */
  const check = async (watcher, resetIds = []) => {
    if (watchers.get(watcher.root) !== watcher || watcher.subscribers.size === 0) {
      return;
    }
    clearTimer(watcher);
    if (watcher.checking) {
      watcher.recheckRequested = true;
      for (const id of resetIds) {
        watcher.resetRequested.add(id);
      }
      return;
    }

    watcher.checking = true;
    const requestedResetIds = new Set([...watcher.resetRequested, ...resetIds]);
    watcher.resetRequested.clear();
    const pendingSelfWrites = new Map(watcher.pendingSelfWrites);
    try {
      const snapshot = await readSnapshot(
        watcher.root,
        pendingSelfWrites.keys(),
        Object.keys(watcher.snapshot?.pathSignatures ?? {}),
      );
      const pendingWritesChanged =
        watcher.pendingSelfWrites.size !== pendingSelfWrites.size ||
        [...pendingSelfWrites].some(
          ([path, pendingWrite]) =>
            watcher.pendingSelfWrites.get(path)?.generation !== pendingWrite.generation,
        );
      if (pendingWritesChanged) {
        watcher.recheckRequested = true;
        for (const id of requestedResetIds) {
          watcher.resetRequested.add(id);
        }
        return;
      }
      if ([...pendingSelfWrites.values()].some(({ completed }) => !completed)) {
        for (const id of requestedResetIds) {
          watcher.resetRequested.add(id);
        }
        return;
      }

      for (const [id, subscriber] of watcher.subscribers) {
        if (requestedResetIds.has(id) || subscriber.snapshot == null) {
          subscriber.changed = false;
          subscriber.snapshot = snapshot;
          continue;
        }
        if (subscriber.changed) {
          continue;
        }

        const expectedPathVersions = new Map(
          [...pendingSelfWrites]
            .filter((entry) => entry[1].ownerId === id && entry[1].version)
            .map(([path, pendingWrite]) => [path, /** @type {string} */ (pendingWrite.version)]),
        );
        if (
          repositoryWatcherSnapshotsMatchExpectedWrites(
            subscriber.snapshot,
            snapshot,
            expectedPathVersions,
          )
        ) {
          subscriber.snapshot = snapshot;
        } else {
          subscriber.changed = true;
          subscriber.notify(snapshot.root);
        }
      }

      watcher.snapshot = snapshot;
      for (const [path, pendingWrite] of pendingSelfWrites) {
        const currentWrite = watcher.pendingSelfWrites.get(path);
        if (pendingWrite.completed && currentWrite?.generation === pendingWrite.generation) {
          watcher.pendingSelfWrites.delete(path);
        }
      }
    } finally {
      watcher.checking = false;
      if (watcher.pendingSelfWrites.size > 0) {
        watcher.recheckRequested = false;
        schedule(watcher, SELF_WRITE_CHECK_DELAY);
      } else if (watcher.recheckRequested || watcher.resetRequested.size > 0) {
        watcher.recheckRequested = false;
        schedule(watcher, 0);
      } else {
        schedulePoll(watcher);
      }
    }
  };

  /** @param {number} id */
  const detach = (id) => {
    const root = subscriberRoots.get(id);
    if (!root) {
      return;
    }
    subscriberRoots.delete(id);
    const watcher = watchers.get(root);
    if (!watcher) {
      return;
    }
    watcher.subscribers.delete(id);
    watcher.resetRequested.delete(id);
    for (const [path, pendingWrite] of watcher.pendingSelfWrites) {
      if (pendingWrite.ownerId === id) {
        watcher.pendingSelfWrites.delete(path);
      }
    }
    if (watcher.subscribers.size === 0) {
      clearTimer(watcher);
      watchers.delete(root);
    } else {
      schedule(watcher, 0);
    }
  };

  return {
    /**
     * @param {{
     *   getState: () => {focused: boolean; visible: boolean};
     *   id: number;
     *   notify: (root: string) => void;
     *   root: string;
     * }} subscriber
     */
    async attach(subscriber) {
      const currentRoot = subscriberRoots.get(subscriber.id);
      if (currentRoot && currentRoot !== subscriber.root) {
        detach(subscriber.id);
      }

      let watcher = watchers.get(subscriber.root);
      if (!watcher) {
        watcher = {
          checking: false,
          pendingSelfWrites: new Map(),
          recheckRequested: false,
          resetRequested: new Set(),
          root: subscriber.root,
          subscribers: new Map(),
        };
        watchers.set(subscriber.root, watcher);
      }
      watcher.subscribers.set(subscriber.id, {
        changed: false,
        getState: subscriber.getState,
        notify: subscriber.notify,
        snapshot: watcher.snapshot,
      });
      subscriberRoots.set(subscriber.id, subscriber.root);

      if (watcher.snapshot == null) {
        await check(watcher, [subscriber.id]);
      } else {
        schedulePoll(watcher);
      }
    },

    /** @param {number} id @param {string} path */
    beginWrite(id, path) {
      const root = subscriberRoots.get(id);
      const watcher = root ? watchers.get(root) : undefined;
      const subscriber = watcher?.subscribers.get(id);
      if (!watcher || !subscriber || subscriber.changed) {
        return null;
      }

      const normalizedPath = normalizeRepositoryWatcherPath(path);
      const generation = (watcher.pendingSelfWrites.get(normalizedPath)?.generation ?? 0) + 1;
      watcher.pendingSelfWrites.set(normalizedPath, {
        completed: false,
        generation,
        ownerId: id,
      });
      if (watcher.checking) {
        watcher.recheckRequested = true;
      }
      return { generation, path: normalizedPath, root };
    },

    /** @param {number} id */
    async checkNow(id) {
      const root = subscriberRoots.get(id);
      const watcher = root ? watchers.get(root) : undefined;
      if (watcher) {
        await check(watcher);
      }
    },

    detach,

    /** @param {{generation: number; path: string; root: string} | null} token @param {string | null} version */
    finishWrite(token, version) {
      if (!token) {
        return;
      }
      const watcher = watchers.get(token.root);
      const pendingWrite = watcher?.pendingSelfWrites.get(token.path);
      if (!watcher || pendingWrite?.generation !== token.generation) {
        return;
      }

      if (version) {
        pendingWrite.completed = true;
        pendingWrite.version = version;
      } else {
        watcher.pendingSelfWrites.delete(token.path);
      }
      schedule(watcher, SELF_WRITE_CHECK_DELAY);
    },

    /** @param {number} id */
    focus(id) {
      const root = subscriberRoots.get(id);
      const watcher = root ? watchers.get(root) : undefined;
      if (watcher?.subscribers.get(id)?.changed === false) {
        schedule(watcher, 0);
      }
    },

    getWatcherCount() {
      return watchers.size;
    },

    /** @param {string} root */
    getWatcherSubscriberCount(root) {
      return watchers.get(root)?.subscribers.size ?? 0;
    },

    /** @param {number} id @param {string} root */
    async reset(id, root) {
      const watcherRoot = subscriberRoots.get(id);
      const watcher = watcherRoot === root ? watchers.get(root) : undefined;
      if (watcher) {
        await check(watcher, [id]);
      }
    },

    /** @param {number} id */
    visibilityChanged(id) {
      const root = subscriberRoots.get(id);
      const watcher = root ? watchers.get(root) : undefined;
      if (watcher) {
        schedulePoll(watcher);
      }
    },
  };
};

module.exports = {
  createRepositoryWatcherCoordinator,
  getRepositoryWatcherPollInterval,
  normalizeRepositoryWatcherPath,
  parseRepositoryWatcherStatus,
  readRepositoryChangeSignature,
  readRepositoryWatcherSnapshot,
  repositoryWatcherSnapshotsMatchExpectedWrites,
};
