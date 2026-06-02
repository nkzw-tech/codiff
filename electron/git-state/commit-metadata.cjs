// @ts-check

const { fileSort, getGravatarHash, git, gitBufferWithInput, gitOrEmpty } = require('./common.cjs');

/**
 * @typedef {import('../../src/types.ts').CommitMetadata} CommitMetadata
 * @typedef {import('../../src/types.ts').CommitMetadataFile} CommitMetadataFile
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {{additions?: number; binary: boolean; deletions?: number; path: string}} NumstatItem
 */

/** @param {string} email */
const createGravatarUrl = (email) =>
  email ? `https://www.gravatar.com/avatar/${getGravatarHash(email)}?s=80&d=identicon` : undefined;

/**
 * @param {string} raw
 * @returns {Map<string, NumstatItem>}
 */
const parseNumstat = (raw) => {
  /** @type {Map<string, NumstatItem>} */
  const stats = new Map();
  const parts = raw.split('\0');

  for (let index = 0; index < parts.length; ) {
    const header = parts[index++];
    if (!header) {
      // `-z` output ends with a NUL, which produces one empty trailing record.
      continue;
    }

    // Paths may contain tabs, so only the first two tabs are numstat separators.
    const firstTab = header.indexOf('\t');
    const secondTab = firstTab === -1 ? -1 : header.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new Error(`Unexpected git numstat record: ${header}`);
    }

    const additionsText = header.slice(0, firstTab);
    const deletionsText = header.slice(firstTab + 1, secondTab);
    const pathField = header.slice(secondTab + 1);
    const isRename = pathField === '';
    // For rename records, `--numstat -z` stores old and new paths in the next two records.
    const path = isRename ? parts[index + 1] : pathField;
    if (isRename) {
      index += 2;
    }
    if (!path) {
      throw new Error(`Unexpected git numstat record without a path: ${header}`);
    }

    const binary = additionsText === '-' || deletionsText === '-';
    stats.set(path, {
      binary,
      path,
      ...(binary
        ? {}
        : {
            additions: Number(additionsText),
            deletions: Number(deletionsText),
          }),
    });
  }

  return stats;
};

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string | undefined} firstParent
 */
const readCommitNumstat = async (repoRoot, commit, firstParent) =>
  parseNumstat(
    await git(
      repoRoot,
      firstParent
        ? ['diff', '--numstat', '-z', '--find-renames', firstParent, commit]
        : ['show', '--format=', '--numstat', '-z', '--find-renames', commit],
    ),
  );

/** @param {string} raw */
const parseTrailers = (raw) =>
  raw.split('\n').flatMap((line) => {
    const separator = line.indexOf(':');
    if (separator === -1) {
      return [];
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    return key && value ? [{ key, value }] : [];
  });

/**
 * @param {string} repoRoot
 * @param {string} subject
 * @param {string} body
 */
const readCommitMessageParts = async (repoRoot, subject, body) => {
  const message = `${subject}\n\n${body}`;
  const [rawTrailerBlock, parsedTrailerBlock] = await Promise.all([
    gitBufferWithInput(
      repoRoot,
      ['interpret-trailers', '--only-trailers', '--only-input'],
      message,
    ),
    gitBufferWithInput(repoRoot, ['interpret-trailers', '--parse'], message),
  ]);
  const trailerBlock = rawTrailerBlock.toString('utf8').trimEnd();
  const trimmedBody = body.trimEnd();

  return {
    body:
      trailerBlock && trimmedBody.endsWith(trailerBlock)
        ? trimmedBody.slice(0, -trailerBlock.length).trimEnd()
        : body,
    trailers: parseTrailers(parsedTrailerBlock.toString('utf8')),
  };
};

/** @param {string} raw */
const parseCommitMetadataHeader = (raw) => {
  const parts = raw.split('\0');
  const [
    ref,
    shortRef,
    parents,
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    committerDate,
    subject,
    body,
    signatureStatus,
    signatureSigner,
    signatureKey,
  ] = parts;

  return {
    author: createCommitMetadataPerson(authorName, authorEmail, authorDate),
    body: body || '',
    committer: createCommitMetadataPerson(committerName, committerEmail, committerDate),
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    ref: ref || '',
    shortRef: shortRef || '',
    signature: {
      ...(signatureKey ? { key: signatureKey.trim() } : {}),
      ...(signatureSigner ? { signer: signatureSigner } : {}),
      status: signatureStatus || 'N',
    },
    subject: subject || '',
  };
};

/**
 * @param {string | undefined} name
 * @param {string | undefined} email
 * @param {string | undefined} date
 */
const createCommitMetadataPerson = (name, email, date) => ({
  date: date || '',
  email: email || '',
  gravatarUrl: createGravatarUrl(email || ''),
  name: name || '',
});

/**
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} status
 * @param {ReadonlyMap<string, NumstatItem>} numstat
 * @returns {Array<CommitMetadataFile>}
 */
const createCommitMetadataFiles = (status, numstat) =>
  status.map((item) => {
    const stats = numstat.get(item.path);
    return {
      binary: stats?.binary ?? false,
      oldPath: item.oldPath,
      path: item.path,
      status: item.status,
      ...(stats && !stats.binary
        ? {
            additions: stats.additions ?? 0,
            deletions: stats.deletions ?? 0,
          }
        : {}),
    };
  });

/** @param {ReadonlyArray<CommitMetadataFile>} files */
const createCommitMetadataStats = (files) => {
  const stats = {
    additions: 0,
    binaryFiles: 0,
    deletions: 0,
    files: files.length,
    renamedFiles: 0,
  };

  for (const file of files) {
    stats.additions += file.additions ?? 0;
    stats.binaryFiles += file.binary ? 1 : 0;
    stats.deletions += file.deletions ?? 0;
    stats.renamedFiles += file.oldPath ? 1 : 0;
  }

  return stats;
};

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string | undefined} firstParent
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} status
 * @returns {Promise<CommitMetadata>}
 */
const readCommitMetadataForCommit = async (repoRoot, commit, firstParent, status) => {
  const rawHeader = await git(repoRoot, [
    'show',
    '-s',
    '--format=%H%x00%h%x00%P%x00%aN%x00%aE%x00%aI%x00%cN%x00%cE%x00%cI%x00%s%x00%b%x00%G?%x00%GS%x00%GK',
    commit,
  ]);
  const header = parseCommitMetadataHeader(rawHeader);
  const [numstat, refs, messageParts] = await Promise.all([
    readCommitNumstat(repoRoot, commit, firstParent),
    gitOrEmpty(repoRoot, ['for-each-ref', '--points-at', commit, '--format=%(refname:short)']),
    readCommitMessageParts(repoRoot, header.subject, header.body),
  ]);
  const files = createCommitMetadataFiles(status, numstat).sort(fileSort);

  return {
    ...header,
    body: messageParts.body,
    files,
    ref: commit,
    refs: refs
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
    stats: createCommitMetadataStats(files),
    trailers: messageParts.trailers,
  };
};

module.exports = {
  readCommitMetadataForCommit,
};
