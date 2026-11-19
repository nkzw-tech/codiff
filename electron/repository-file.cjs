// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { open, readFile, realpath, rename, stat, unlink } = require('node:fs/promises');
const { basename, dirname, isAbsolute, relative, resolve, sep } = require('node:path');

const { gitOrEmpty } = require('./git-state/common.cjs');

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** @param {string} content */
const hashContent = (content) => createHash('sha256').update(content).digest('hex');

/** @param {string} root @param {string} path */
const isWithinRoot = (root, path) => {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** @param {string} repositoryRoot @param {string} path */
const resolveRepositoryFile = async (repositoryRoot, path) => {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) {
    throw new Error('Invalid repository file path.');
  }
  const root = await realpath(repositoryRoot);
  const requestedPath = resolve(root, path);
  const absolutePath = await realpath(requestedPath);
  if (!isWithinRoot(root, requestedPath) || !isWithinRoot(root, absolutePath)) {
    throw new Error('File path escapes the repository.');
  }
  // Git metadata must never be editable through the code surface.
  if (
    relative(root, requestedPath).split(sep).includes('.git') ||
    relative(root, absolutePath).split(sep).includes('.git')
  ) {
    throw new Error('Git metadata cannot be edited.');
  }
  return { absolutePath, path, root };
};

/** @param {{absolutePath: string; path: string; root: string}} resolved */
const readResolvedFile = async (resolved) => {
  const fileStat = await stat(resolved.absolutePath);
  if (!fileStat.isFile()) {
    throw new Error('Only regular files can be edited.');
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error('File exceeds the 2 MB editing limit.');
  }
  const bytes = await readFile(resolved.absolutePath);
  const content = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) {
    throw new Error('Only UTF-8 text files can be edited.');
  }
  return { content, path: resolved.path, root: resolved.root, version: hashContent(content) };
};

/** @param {string} repositoryRoot @param {string} path */
const readRepositoryFile = async (repositoryRoot, path) => {
  const document = await readResolvedFile(await resolveRepositoryFile(repositoryRoot, path));
  if (document.content.includes('$Id:')) {
    const ident = await gitOrEmpty(document.root, ['check-attr', '-z', 'ident', '--', path]);
    if (ident.split('\0')[2] === 'set') return { ...document, gitIdent: true };
  }
  return document;
};

/**
 * @param {string} repositoryRoot
 * @param {import('../core/types.ts').SaveRepositoryFileRequest} request
 * @returns {Promise<import('../core/types.ts').SaveRepositoryFileResult>}
 */
const writeRepositoryFile = async (repositoryRoot, request) => {
  if (
    typeof request.content !== 'string' ||
    request.content.includes('\0') ||
    Buffer.byteLength(request.content, 'utf8') > MAX_FILE_BYTES
  ) {
    throw new Error('File must be UTF-8 text within the 2 MB editing limit.');
  }
  const resolved = await resolveRepositoryFile(repositoryRoot, request.path);
  if (request.root !== resolved.root) {
    throw new Error('The edited file belongs to a different repository.');
  }
  const current = await readResolvedFile(resolved);
  if (current.content === request.content) {
    return { document: current, status: 'saved' };
  }
  if (current.version !== request.baseVersion) {
    return { document: current, status: 'conflict' };
  }
  const temporaryPath = resolve(
    dirname(resolved.absolutePath),
    `.${basename(resolved.absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const mode = (await stat(resolved.absolutePath)).mode & 0o7777;
  const file = await open(temporaryPath, 'wx', mode);
  try {
    await file.chmod(mode);
    await file.writeFile(request.content, 'utf8');
    await file.sync();
    await file.close();
    // Check again after preparing the replacement, including symlink retargets.
    const latestResolved = await resolveRepositoryFile(repositoryRoot, request.path);
    const latest = await readResolvedFile(latestResolved);
    if (
      latestResolved.absolutePath !== resolved.absolutePath ||
      latest.version !== current.version
    ) {
      await unlink(temporaryPath);
      return { document: latest, status: 'conflict' };
    }
    await rename(temporaryPath, resolved.absolutePath);
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { document: await readResolvedFile(resolved), status: 'saved' };
};

module.exports = { readRepositoryFile, resolveRepositoryFile, writeRepositoryFile };
