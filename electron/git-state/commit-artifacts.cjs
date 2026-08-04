// @ts-check

const { StringDecoder } = require('node:string_decoder');
const {
  getFingerprint,
  git,
  gitBufferWithInput,
  gitStreamWithInput,
  normalizeStatus,
} = require('./common.cjs');

/** @typedef {import('../../core/lib/review-artifacts.ts').ArtifactFile} ArtifactFile */
/** @typedef {import('../../core/lib/review-artifacts.ts').CommitArtifact} CommitArtifact */
/** @typedef {import('../../core/lib/review-artifacts.ts').CommitArtifactRequest} CommitArtifactRequest */
/** @typedef {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} ReviewArtifactProject */
/** @typedef {import('../../core/lib/review-artifacts.ts').ReviewArtifactProvenance} ReviewArtifactProvenance */
/** @typedef {import('../../core/types.ts').ChangedFile} ChangedFile */
/** @typedef {import('../../core/types.ts').GitSha} GitSha */

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_COMMIT_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_RANGE_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_ENDPOINT_LOOKUP_BYTES = 1024 * 1024;
const MAX_BLOB_HEADER_BYTES = 1024;

const COMMIT_LINE =
  /^commit ((?:[0-9a-f]{40}|[0-9a-f]{64}))(?: ((?:[0-9a-f]{40}|[0-9a-f]{64})(?: (?:[0-9a-f]{40}|[0-9a-f]{64}))*))?\s*$/;
const RAW_LINE =
  /^:([0-7]{6}) ([0-7]{6}) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ([A-Z])\d*\t(.+)$/;

/** @param {string} value */
const decodePath = (value) => {
  if (!value.startsWith('"')) {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value.slice(1, -1);
  }
};

/** @param {string} line @returns {ArtifactFile | null} */
const parseRawLine = (line) => {
  const match = RAW_LINE.exec(line);
  if (!match) {
    return null;
  }
  const [, oldMode, newMode, oldObjectId, newObjectId, statusCode, rawPaths] = match;
  const paths = rawPaths.split('\t').map(decodePath);
  const path = statusCode === 'R' || statusCode === 'C' ? paths[1] : paths[0];
  if (!path) {
    return null;
  }
  const oldPath = statusCode === 'R' || statusCode === 'C' ? paths[0] : undefined;
  return {
    coverage: 'complete',
    newMode,
    newObjectId,
    oldMode,
    oldObjectId,
    ...(oldPath ? { oldPath } : {}),
    path,
    status: normalizeStatus(statusCode),
  };
};

/**
 * Parse one raw + patch artifact block. A stream truncated at its request
 * boundary cannot prove its final patch block complete, even when that prefix
 * happens to parse as a valid patch.
 *
 * @param {ReadonlyArray<string>} lines
 * @param {{truncated?: boolean}} [options]
 * @returns {{coverage: import('../../core/lib/review-artifacts.ts').ArtifactCoverage, files: Array<ArtifactFile>}}
 */
const parseArtifactBlock = (lines, options = {}) => {
  const truncated = options.truncated === true;
  const files = lines
    .filter((line) => line.startsWith(':'))
    .map(parseRawLine)
    .filter((file) => file != null);
  const rawCount = lines.filter((line) => line.startsWith(':')).length;
  const body = lines.join('\n');
  const patchStarts = [...body.matchAll(/^diff --git /gm)].map((match) => match.index || 0);
  const patches = patchStarts.map((start, index) =>
    body.slice(start, patchStarts[index + 1] ?? body.length).trimEnd(),
  );
  // A following diff header proves that the preceding patch block ended. The
  // final observed block has no such proof after the stream budget cuts off.
  const completePatchCount = truncated ? Math.max(0, patches.length - 1) : patches.length;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const patch = patches[index];
    if (patch) {
      file.patch = patch;
    }
    if (truncated && index >= completePatchCount) {
      file.coverage = 'truncated';
    } else if (!patch && !file.oldObjectId && !file.newObjectId && file.oldMode === file.newMode) {
      file.coverage = 'truncated';
    }
  }
  const coverage =
    truncated || rawCount !== files.length || patches.length > files.length
      ? 'truncated'
      : files.some((file) => file.coverage === 'truncated')
        ? 'truncated'
        : 'complete';
  return { coverage, files };
};

/**
 * @param {GitSha} commitSha
 * @param {GitSha | null} parentSha
 * @param {ReadonlyArray<string>} lines
 * @param {ReviewArtifactProvenance} provenance
 * @returns {CommitArtifact}
 */
const parseCommitBlock = (commitSha, parentSha, lines, provenance) => {
  const artifact = parseArtifactBlock(lines);
  return { commitSha, ...artifact, parentSha, provenance };
};

/** @param {string} output */
const parseStackOutput = (output) =>
  output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, authorName, authoredAt, subject] = line.split('\0');
      return {
        authoredAt,
        authorName: authorName || 'Unknown',
        parentShas: parents ? parents.split(' ').filter(Boolean) : [],
        sha,
        shortSha: sha.slice(0, 7),
        subject: subject || sha.slice(0, 7),
      };
    });

/**
 * Parse the combined raw + patch stream emitted by `git diff-tree --stdin`.
 * @param {string} output
 * @param {ReviewArtifactProvenance} provenance
 * @returns {ReadonlyMap<GitSha, CommitArtifact>}
 */
const parseCommitArtifactOutput = (output, provenance) => {
  /** @type {Map<GitSha, CommitArtifact>} */
  const result = new Map();
  /** @type {GitSha | null} */
  let commitSha = null;
  /** @type {GitSha | null} */
  let parentSha = null;
  /** @type {Array<string>} */
  let lines = [];
  const finish = () => {
    if (commitSha) {
      result.set(commitSha, parseCommitBlock(commitSha, parentSha, lines, provenance));
    }
  };
  for (const line of output.split('\n')) {
    const commit = COMMIT_LINE.exec(line);
    if (commit) {
      finish();
      commitSha = /** @type {GitSha} */ (commit[1]);
      parentSha = commit[2] ? /** @type {GitSha} */ (commit[2].split(' ')[0]) : null;
      lines = [];
    } else if (commitSha) {
      lines.push(line);
    }
  }
  finish();
  return result;
};

/** @param {CommitArtifact} artifact */
const truncateCommitArtifact = (artifact) => ({
  ...artifact,
  coverage: 'truncated',
  files: artifact.files.map((file) => ({ ...file, coverage: 'truncated' })),
});

/**
 * Parse a `diff-tree --stdin` stream while retaining no more than its explicit
 * request budget. Once the budget is reached we continue draining Git's pipe,
 * but the active and unobserved commits become conservative incomplete
 * artifacts rather than partial complete evidence.
 *
 * @param {ReadonlyArray<GitSha>} commits
 * @param {ReviewArtifactProvenance} provenance
 * @param {number} maxBytes
 */
const createBoundedCommitArtifactParser = (commits, provenance, maxBytes) => {
  const requested = [...new Set(commits)];
  const decoder = new StringDecoder('utf8');
  const limit = Math.max(0, Math.floor(maxBytes));
  /** @type {Map<GitSha, CommitArtifact>} */
  const result = new Map();
  /** @type {GitSha | null} */
  let commitSha = null;
  /** @type {GitSha | null} */
  let parentSha = null;
  /** @type {Array<string>} */
  let lines = [];
  let retainedBytes = 0;
  let truncated = false;
  let pendingLine = '';

  /** @param {boolean} isTruncated */
  const finishCommit = (isTruncated) => {
    if (!commitSha) return;
    const artifact = parseCommitBlock(commitSha, parentSha, lines, provenance);
    result.set(commitSha, isTruncated ? truncateCommitArtifact(artifact) : artifact);
    commitSha = null;
    parentSha = null;
    lines = [];
  };

  /** @param {string} line */
  const consumeLine = (line) => {
    const commit = COMMIT_LINE.exec(line);
    if (commit) {
      finishCommit(false);
      commitSha = /** @type {GitSha} */ (commit[1]);
      parentSha = commit[2] ? /** @type {GitSha} */ (commit[2].split(' ')[0]) : null;
      return;
    }
    if (commitSha) {
      lines.push(line);
    }
  };

  /** @param {string} text */
  const consumeText = (text) => {
    let remaining = pendingLine + text;
    let newline = remaining.indexOf('\n');
    while (newline !== -1) {
      consumeLine(remaining.slice(0, newline));
      remaining = remaining.slice(newline + 1);
      newline = remaining.indexOf('\n');
    }
    pendingLine = remaining;
  };

  return {
    /** @param {Buffer} value */
    write(value) {
      if (truncated) return;
      const remaining = limit - retainedBytes;
      if (value.length <= remaining) {
        retainedBytes += value.length;
        consumeText(decoder.write(value));
        return;
      }
      if (remaining > 0) {
        retainedBytes += remaining;
        consumeText(decoder.write(value.subarray(0, remaining)));
      }
      // The last retained bytes can end in a partial UTF-8 sequence or line.
      // Neither is enough to establish a complete artifact file.
      pendingLine = '';
      truncated = true;
      finishCommit(true);
    },
    finish() {
      if (!truncated) {
        consumeText(decoder.end());
        if (pendingLine) {
          consumeLine(pendingLine);
          pendingLine = '';
        }
        finishCommit(false);
      }
      for (const commit of requested) {
        if (!result.has(commit)) {
          result.set(commit, {
            commitSha: commit,
            coverage: 'truncated',
            files: [],
            parentSha: null,
            provenance,
          });
        }
      }
      return result;
    },
  };
};

/**
 * Parse one native range diff while retaining no more than its explicit
 * request budget. Git continues draining after the budget is reached so a
 * very large range cannot leave its child process blocked on stdout.
 *
 * @param {number} maxBytes
 */
const createBoundedRangeArtifactParser = (maxBytes) => {
  const decoder = new StringDecoder('utf8');
  const limit = Math.max(0, Math.floor(maxBytes));
  /** @type {Array<string>} */
  const lines = [];
  let pendingLine = '';
  let retainedBytes = 0;
  let truncated = false;

  /** @param {string} text */
  const consumeText = (text) => {
    let remaining = pendingLine + text;
    let newline = remaining.indexOf('\n');
    while (newline !== -1) {
      lines.push(remaining.slice(0, newline));
      remaining = remaining.slice(newline + 1);
      newline = remaining.indexOf('\n');
    }
    pendingLine = remaining;
  };

  return {
    /** @param {Buffer} value */
    write(value) {
      if (truncated) return;
      const remaining = limit - retainedBytes;
      if (value.length <= remaining) {
        retainedBytes += value.length;
        consumeText(decoder.write(value));
        return;
      }
      if (remaining > 0) {
        retainedBytes += remaining;
        consumeText(decoder.write(value.subarray(0, remaining)));
      }
      // The final retained bytes can finish in a partial UTF-8 sequence or
      // patch line. Discard that incomplete line and mark its file incomplete.
      pendingLine = '';
      truncated = true;
    },
    finish() {
      if (!truncated) {
        consumeText(decoder.end());
        if (pendingLine) {
          lines.push(pendingLine);
          pendingLine = '';
        }
      }
      return parseArtifactBlock(lines, { truncated });
    },
  };
};

/**
 * Read all requested Commit Artifacts in one native Git diff process.
 * @param {string} repoRoot
 * @param {ReadonlyArray<GitSha>} commits
 * @param {{maxBytes?: number, provenance?: ReviewArtifactProvenance, runGit?: typeof gitBufferWithInput, runGitStream?: typeof gitStreamWithInput, signal?: AbortSignal}} [options]
 * @returns {Promise<ReadonlyMap<GitSha, CommitArtifact>>}
 */
const readCommitArtifacts = async (repoRoot, commits, options = {}) => {
  const unique = [...new Set(commits)];
  if (unique.length === 0) {
    return new Map();
  }
  for (const sha of unique) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
      throw new Error(`Invalid commit SHA for artifact acquisition: ${sha}`);
    }
  }
  options.signal?.throwIfAborted();
  const provenance = options.provenance || {
    kind: 'native-git',
    project: { host: 'local', project: repoRoot, provider: 'git' },
  };
  const args = [
    'diff-tree',
    '--stdin',
    '--root',
    '-r',
    '-M',
    '-m',
    '--first-parent',
    '--patch-with-raw',
    '--full-index',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--pretty=format:commit%x20%H%x20%P',
  ];
  const input = `${unique.join('\n')}\n`;
  if (options.runGit) {
    const output = await options.runGit(repoRoot, args, input, { signal: options.signal });
    options.signal?.throwIfAborted();
    return parseCommitArtifactOutput(output.toString('utf8'), provenance);
  }
  const parser = createBoundedCommitArtifactParser(
    unique,
    provenance,
    options.maxBytes ?? MAX_COMMIT_ARTIFACT_BYTES,
  );
  await (options.runGitStream || gitStreamWithInput)(repoRoot, args, input, {
    onStdout: (chunk) => parser.write(chunk),
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  return parser.finish();
};

/**
 * Read one immutable Range Artifact through a bounded native Git diff.
 * Buffered injection remains available for unit tests; production always
 * streams and drains the child process while retaining only the request cap.
 *
 * @param {string} repoRoot
 * @param {GitSha} baseSha
 * @param {GitSha} headSha
 * @param {{maxBytes?: number, runGit?: typeof gitBufferWithInput, runGitStream?: typeof gitStreamWithInput, signal?: AbortSignal}} [options]
 */
const readRangeArtifact = async (repoRoot, baseSha, headSha, options = {}) => {
  for (const sha of [baseSha, headSha]) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
      throw new Error(`Invalid range SHA for artifact acquisition: ${sha}`);
    }
  }
  options.signal?.throwIfAborted();
  const args = [
    'diff',
    '--raw',
    '--patch',
    '--full-index',
    '--no-abbrev',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '-M',
    baseSha,
    headSha,
  ];
  if (options.runGit) {
    const output = await options.runGit(repoRoot, args, '', { signal: options.signal });
    options.signal?.throwIfAborted();
    return parseArtifactBlock(output.toString('utf8').split('\n'));
  }
  const parser = createBoundedRangeArtifactParser(options.maxBytes ?? MAX_RANGE_ARTIFACT_BYTES);
  await (options.runGitStream || gitStreamWithInput)(repoRoot, args, '', {
    onStdout: (chunk) => parser.write(chunk),
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  return parser.finish();
};

/**
 * Parse one `git cat-file --batch` stream without retaining more than the
 * request budget. Only a complete object record becomes a Blob Artifact: when
 * a large object reaches the cap, the active object and the unobserved tail
 * remain missing evidence while the caller keeps draining Git's stdout.
 *
 * @param {ReviewArtifactProvenance} provenance
 * @param {number} maxBytes
 */
const createBoundedBlobArtifactParser = (provenance, maxBytes) => {
  const limit = Math.max(0, Math.floor(maxBytes));
  /** @type {Map<string, import('../../core/lib/review-artifacts.ts').BlobArtifact>} */
  const blobs = new Map();
  /** @type {{bytes: Uint8Array | null, objectId: string, offset: number, size: number} | null} */
  let current = null;
  let header = '';
  let retainedBytes = 0;
  let truncated = false;

  const stop = () => {
    current = null;
    header = '';
    truncated = true;
  };

  /** @param {string} value */
  const beginRecord = (value) => {
    if (value.endsWith(' missing')) {
      return;
    }
    const match = /^((?:[0-9a-f]{40}|[0-9a-f]{64})) ([^ ]+) (\d+)$/i.exec(value);
    if (!match) {
      stop();
      return;
    }
    const [, objectId, type, rawSize] = match;
    const size = Number(rawSize);
    if (!objectId || !Number.isSafeInteger(size) || size < 0 || size + 1 > limit - retainedBytes) {
      stop();
      return;
    }
    current = {
      bytes: type === 'blob' ? new Uint8Array(size) : null,
      objectId,
      offset: 0,
      size,
    };
  };

  /** @param {Buffer} value */
  const consume = (value) => {
    let offset = 0;
    while (offset < value.length && !truncated) {
      const available = limit - retainedBytes;
      if (available <= 0) {
        stop();
        break;
      }
      if (!current) {
        const newline = value.indexOf(10, offset);
        const end = newline === -1 ? value.length : newline + 1;
        const length = end - offset;
        const accepted = Math.min(length, available);
        const fragment = value.subarray(
          offset,
          newline !== -1 && accepted === length ? newline : offset + accepted,
        );
        if (header.length + fragment.length > MAX_BLOB_HEADER_BYTES) {
          stop();
          break;
        }
        header += fragment.toString('ascii');
        retainedBytes += accepted;
        offset += accepted;
        if (accepted < length) {
          stop();
          break;
        }
        if (newline === -1) {
          break;
        }
        const record = header;
        header = '';
        beginRecord(record);
        continue;
      }
      if (current.offset < current.size) {
        const length = Math.min(current.size - current.offset, value.length - offset, available);
        if (length <= 0) {
          stop();
          break;
        }
        if (current.bytes) {
          current.bytes.set(value.subarray(offset, offset + length), current.offset);
        }
        current.offset += length;
        retainedBytes += length;
        offset += length;
        if (current.offset < current.size) {
          continue;
        }
      }
      if (offset >= value.length) {
        break;
      }
      if (limit - retainedBytes <= 0 || value[offset] !== 10) {
        stop();
        break;
      }
      retainedBytes += 1;
      offset += 1;
      if (current.bytes) {
        blobs.set(current.objectId, {
          bytes: current.bytes,
          objectId: current.objectId,
          provenance,
        });
      }
      current = null;
    }
    return offset;
  };

  return {
    /** @param {Buffer} value */
    write(value) {
      if (truncated || value.length === 0) return;
      const consumed = consume(value);
      if (consumed < value.length) {
        stop();
      }
    },
    finish() {
      return blobs;
    },
  };
};

/**
 * Read immutable Git blobs in one bounded batch process. Buffered injection
 * remains available for unit tests; production streams and drains stdout.
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} objectIds
 * @param {{maxBytes?: number, provenance: ReviewArtifactProvenance, signal?: AbortSignal, runGit?: typeof gitBufferWithInput, runGitStream?: typeof gitStreamWithInput}} options
 */
const readBlobArtifacts = async (repoRoot, objectIds, options) => {
  const unique = [...new Set(objectIds)];
  if (unique.length === 0) {
    return new Map();
  }
  for (const objectId of unique) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(objectId)) {
      throw new Error(`Invalid Git object ID for blob acquisition: ${objectId}`);
    }
  }
  options.signal?.throwIfAborted();
  const parser = createBoundedBlobArtifactParser(
    options.provenance,
    options.maxBytes ?? MAX_BLOB_ARTIFACT_BYTES,
  );
  const args = ['cat-file', '--batch'];
  const input = `${unique.join('\n')}\n`;
  if (options.runGit) {
    parser.write(await options.runGit(repoRoot, args, input, { signal: options.signal }));
  } else {
    await (options.runGitStream || gitStreamWithInput)(repoRoot, args, input, {
      onStdout: (chunk) => parser.write(chunk),
      signal: options.signal,
    });
  }
  options.signal?.throwIfAborted();
  return parser.finish();
};

/** @param {{path: string, ref: string}} request */
const blobRequestKey = (request) => `${request.ref}:${request.path}`;
/** @param {{commitSha: string, parentSha: string | null}} request */
const commitRequestKey = (request) => `${request.commitSha}:${request.parentSha ?? 'root'}`;

/**
 * Parse one `git cat-file --batch-check` stream while retaining just the
 * bounded response lines needed to map replay endpoints to immutable object
 * IDs. A truncated tail intentionally leaves later endpoints unresolved.
 *
 * @param {ReadonlyArray<{path: string, ref: string}>} requests
 * @param {number} maxBytes
 */
const createBoundedBlobObjectIdParser = (requests, maxBytes) => {
  const decoder = new StringDecoder('utf8');
  const limit = Math.max(0, Math.floor(maxBytes));
  const resolved = new Map();
  let nextRequest = 0;
  let pendingLine = '';
  let retainedBytes = 0;
  let truncated = false;

  /** @param {string} line */
  const consumeLine = (line) => {
    const request = requests[nextRequest++];
    if (!request) return;
    const [objectId, type] = line.split(' ');
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(objectId || '') && type === 'blob') {
      resolved.set(blobRequestKey(request), objectId);
    }
  };

  /** @param {string} text */
  const consumeText = (text) => {
    let remaining = pendingLine + text;
    let newline = remaining.indexOf('\n');
    while (newline !== -1) {
      consumeLine(remaining.slice(0, newline));
      remaining = remaining.slice(newline + 1);
      newline = remaining.indexOf('\n');
    }
    pendingLine = remaining;
  };

  return {
    /** @param {Buffer} value */
    write(value) {
      if (truncated || value.length === 0) return;
      const remaining = limit - retainedBytes;
      if (value.length <= remaining) {
        retainedBytes += value.length;
        consumeText(decoder.write(value));
        return;
      }
      if (remaining > 0) {
        retainedBytes += remaining;
        consumeText(decoder.write(value.subarray(0, remaining)));
      }
      pendingLine = '';
      truncated = true;
    },
    finish() {
      if (!truncated) {
        consumeText(decoder.end());
        if (pendingLine) {
          consumeLine(pendingLine);
          pendingLine = '';
        }
      }
      return resolved;
    },
  };
};

/**
 * Resolve endpoint paths that were not already named by an Artifact's raw
 * records. This remains one native Git process for the whole proof batch;
 * callers then pass the resolved immutable IDs to the Artifact Run's cached
 * `readBlobs` method.
 *
 * Newlines cannot be represented safely by Git's line-oriented batch input,
 * so those unusual paths are deliberately left unresolved and become explicit
 * incomplete replay evidence instead of being probed serially.
 *
 * @param {string} repoRoot
 * @param {ReadonlyArray<{path: string, ref: string}>} requests
 * @param {{maxBytes?: number, signal?: AbortSignal, runGit?: typeof gitBufferWithInput, runGitStream?: typeof gitStreamWithInput}} [options]
 * @returns {Promise<ReadonlyMap<string, string>>}
 */
const readBlobObjectIds = async (repoRoot, requests, options = {}) => {
  const pending = [
    ...new Map(
      requests
        .filter(({ path }) => !path.includes('\n') && !path.includes('\0'))
        .map((request) => [blobRequestKey(request), request]),
    ).values(),
  ];
  if (pending.length === 0) {
    return new Map();
  }
  for (const { ref } of pending) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref)) {
      throw new Error(`Invalid Git ref for blob endpoint resolution: ${ref}`);
    }
  }
  options.signal?.throwIfAborted();
  const parser = createBoundedBlobObjectIdParser(
    pending,
    options.maxBytes ?? MAX_BLOB_ENDPOINT_LOOKUP_BYTES,
  );
  const args = ['cat-file', '--batch-check=%(objectname) %(objecttype)'];
  const input = `${pending.map(({ path, ref }) => `${ref}:${path}`).join('\n')}\n`;
  if (options.runGit) {
    parser.write(await options.runGit(repoRoot, args, input, { signal: options.signal }));
  } else {
    await (options.runGitStream || gitStreamWithInput)(repoRoot, args, input, {
      onStdout: (chunk) => parser.write(chunk),
      signal: options.signal,
    });
  }
  options.signal?.throwIfAborted();
  return parser.finish();
};

/**
 * Native-Git backend used by one Core Review Artifact Run.
 * Stack/range acquisition is supplied by provider history adapters; this
 * source owns immutable commit and blob objects.
 * @param {string} repoRoot
 * @param {ReviewArtifactProject} project
 * @param {{maxBlobArtifactBytes?: number, maxCommitArtifactBytes?: number, maxRangeArtifactBytes?: number, runGit?: typeof git, runGitStream?: typeof gitStreamWithInput, runGitWithInput?: typeof gitBufferWithInput}} [options]
 */
const createNativeCommitArtifactSource = (repoRoot, project, options = {}) => {
  const provenance = { kind: 'native-git', project };
  const runGit = options.runGit || git;
  const runGitWithInput = options.runGitWithInput || gitBufferWithInput;
  return {
    readBlobs: (objectIds, signal) =>
      readBlobArtifacts(repoRoot, objectIds, {
        ...(options.maxBlobArtifactBytes == null ? {} : { maxBytes: options.maxBlobArtifactBytes }),
        provenance,
        ...(options.runGitWithInput ? { runGit: runGitWithInput } : {}),
        ...(options.runGitStream ? { runGitStream: options.runGitStream } : {}),
        signal,
      }),
    /** @param {ReadonlyArray<import('../../core/lib/review-artifacts.ts').FileBlobArtifactRequest>} requests @param {AbortSignal} signal */
    async readFileBlobs(requests, signal) {
      const unique = [
        ...new Map(requests.map((request) => [blobRequestKey(request), request])).values(),
      ];
      const objectIds = await readBlobObjectIds(repoRoot, unique, {
        ...(options.runGitWithInput ? { runGit: runGitWithInput } : {}),
        ...(options.runGitStream ? { runGitStream: options.runGitStream } : {}),
        signal,
      });
      const defaultLimit = options.maxBlobArtifactBytes ?? MAX_BLOB_ARTIFACT_BYTES;
      const batchLimit = unique.reduce(
        (total, request) => total + (request.maxBytes ?? defaultLimit) + MAX_BLOB_HEADER_BYTES + 1,
        0,
      );
      const blobs = await readBlobArtifacts(repoRoot, [...new Set(objectIds.values())], {
        maxBytes: batchLimit,
        provenance,
        ...(options.runGitWithInput ? { runGit: runGitWithInput } : {}),
        ...(options.runGitStream ? { runGitStream: options.runGitStream } : {}),
        signal,
      });
      return new Map(
        unique.flatMap((request) => {
          const key = blobRequestKey(request);
          const objectId = objectIds.get(key);
          const blob = objectId ? blobs.get(objectId) : null;
          return blob && blob.bytes.byteLength <= (request.maxBytes ?? defaultLimit)
            ? [[key, blob]]
            : [];
        }),
      );
    },
    async readCommitArtifacts(requests, signal) {
      const artifacts = await readCommitArtifacts(
        repoRoot,
        requests.map(({ commitSha }) => commitSha),
        {
          ...(options.maxCommitArtifactBytes == null
            ? {}
            : { maxBytes: options.maxCommitArtifactBytes }),
          provenance,
          ...(options.runGitWithInput ? { runGit: runGitWithInput } : {}),
          signal,
        },
      );
      return new Map(
        requests.flatMap((request) => {
          const artifact = artifacts.get(request.commitSha);
          if (!artifact) {
            return [];
          }
          return [
            [
              commitRequestKey(request),
              artifact.parentSha === request.parentSha
                ? artifact
                : { ...artifact, coverage: 'truncated', parentSha: request.parentSha },
            ],
          ];
        }),
      );
    },
    async readStackAndRange({ headSha, requestedBaseSha: baseSha }, signal) {
      if (baseSha === headSha) {
        return {
          range: { baseSha, coverage: 'complete', files: [], headSha, provenance },
          stack: { baseSha, commits: [], coverage: 'complete', headSha, provenance },
        };
      }
      const [stackOutput, parsedRange] = await Promise.all([
        runGit(
          repoRoot,
          [
            'log',
            '--reverse',
            '--topo-order',
            '--format=%H%x00%P%x00%an%x00%aI%x00%s',
            `${baseSha}..${headSha}`,
          ],
          { signal },
        ),
        readRangeArtifact(repoRoot, baseSha, headSha, {
          ...(options.maxRangeArtifactBytes == null
            ? {}
            : { maxBytes: options.maxRangeArtifactBytes }),
          ...(options.runGitStream ? { runGitStream: options.runGitStream } : {}),
          ...(options.runGitWithInput ? { runGit: runGitWithInput } : {}),
          signal,
        }),
      ]);
      signal.throwIfAborted();
      return {
        range: { baseSha, ...parsedRange, headSha, provenance },
        stack: {
          baseSha,
          commits: parseStackOutput(stackOutput),
          coverage: 'complete',
          headSha,
          provenance,
        },
      };
    },
  };
};

/** @param {string} patch */
const invertPatch = (patch) =>
  patch
    .replace(/^--- (.*)\n\+\+\+ (.*)$/gm, '--- $2\n+++ $1')
    .replace(/^index ([0-9a-f]+)\.\.([0-9a-f]+)(.*)$/gm, 'index $2..$1$3')
    .split('\n')
    .map((line) => {
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (hunk) {
        const [, oldStart, oldCount, newStart, newCount, suffix] = hunk;
        return `@@ -${newStart}${newCount == null ? '' : `,${newCount}`} +${oldStart}${
          oldCount == null ? '' : `,${oldCount}`
        } @@${suffix}`;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `-${line.slice(1)}`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `+${line.slice(1)}`;
      }
      return line;
    })
    .join('\n');

/** @param {ChangedFile['status']} status */
const reverseStatus = (status) =>
  status === 'added' ? 'deleted' : status === 'deleted' ? 'added' : status;

/**
 * Project cached artifact files into the renderer's patch-only shape.
 * @param {{coverage: import('../../core/lib/review-artifacts.ts').ArtifactCoverage, files: ReadonlyArray<ArtifactFile>}} artifact
 * @param {{baseSha: GitSha, headSha: GitSha, identity: string, reverse?: boolean}} options
 * @returns {ReadonlyArray<ChangedFile>}
 */
const artifactFilesToChangedFiles = (artifact, options) => {
  const reverse = options.reverse === true;
  const baseSha = reverse ? options.headSha : options.baseSha;
  const headSha = reverse ? options.baseSha : options.headSha;
  return artifact.files.map((file, index) => {
    const path = reverse ? file.oldPath || file.path : file.path;
    const oldPath = reverse && file.oldPath ? file.path : !reverse ? file.oldPath : undefined;
    const status = reverse ? reverseStatus(file.status) : file.status;
    const patch = reverse ? invertPatch(file.patch || '') : file.patch || '';
    const binary = !patch && Boolean(file.oldObjectId || file.newObjectId);
    const patchUnavailable = file.coverage !== 'complete' && !patch && !binary;
    return {
      fingerprint: getFingerprint(`${options.identity}:${index}:${reverse}:${file.path}:${patch}`),
      ...(oldPath && oldPath !== path ? { oldPath } : {}),
      path,
      sections: [
        {
          binary,
          id: `${path}:artifact:${options.identity}:${reverse ? 'reverse' : 'forward'}`,
          kind: 'commit',
          loadState: patchUnavailable ? 'error' : binary ? 'binary' : 'ready',
          patch,
          range: {
            base: { label: { kind: 'commit', text: baseSha.slice(0, 7) }, sha: baseSha },
            head: { label: { kind: 'commit', text: headSha.slice(0, 7) }, sha: headSha },
          },
          ...(patchUnavailable
            ? {
                summary: {
                  reason: 'Codiff could not load a complete patch for this file.',
                },
              }
            : file.coverage !== 'complete' && patch
              ? {
                  summary: {
                    reason: 'Showing the available patch; some change data may be incomplete.',
                  },
                }
              : {}),
        },
      ],
      status,
    };
  });
};

/**
 * Project a cached Commit Artifact into the renderer's patch-only shape.
 * @param {CommitArtifact} artifact
 * @param {{reverse?: boolean}} [options]
 * @returns {ReadonlyArray<ChangedFile>}
 */
const artifactToChangedFiles = (artifact, options = {}) =>
  artifactFilesToChangedFiles(artifact, {
    baseSha: artifact.parentSha || EMPTY_TREE_SHA,
    headSha: artifact.commitSha,
    identity: `${artifact.parentSha || 'root'}:${artifact.commitSha}`,
    reverse: options.reverse,
  });

/**
 * Project a cached Range Artifact into the renderer's patch-only shape.
 * @param {import('../../core/lib/review-artifacts.ts').RangeArtifact} artifact
 * @returns {ReadonlyArray<ChangedFile>}
 */
const rangeArtifactToChangedFiles = (artifact) =>
  artifactFilesToChangedFiles(artifact, {
    baseSha: artifact.baseSha,
    headSha: artifact.headSha,
    identity: `${artifact.baseSha}:${artifact.headSha}`,
  });

module.exports = {
  artifactToChangedFiles,
  MAX_BLOB_ARTIFACT_BYTES,
  MAX_BLOB_ENDPOINT_LOOKUP_BYTES,
  MAX_COMMIT_ARTIFACT_BYTES,
  MAX_RANGE_ARTIFACT_BYTES,
  createBoundedBlobArtifactParser,
  createBoundedBlobObjectIdParser,
  createNativeCommitArtifactSource,
  createBoundedCommitArtifactParser,
  createBoundedRangeArtifactParser,
  parseCommitArtifactOutput,
  rangeArtifactToChangedFiles,
  readBlobArtifacts,
  readBlobObjectIds,
  readCommitArtifacts,
  readRangeArtifact,
};
