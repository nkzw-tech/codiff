// @ts-check

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const GENERATED_DIRECTORY_NAMES = new Set([
  '__generated__',
  '__snapshots__',
  '.generated',
  'codegen',
  'gen',
  'generated',
  'generated-sources',
  'generated-src',
]);

const GENERATED_BASENAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'gemfile.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'pubspec.lock',
  'uv.lock',
  'yarn.lock',
]);

const GENERATED_EXTENSIONS = [
  '.d.ts.map',
  '.g.dart',
  '.generated.cjs',
  '.generated.css',
  '.generated.js',
  '.generated.jsx',
  '.generated.mjs',
  '.generated.ts',
  '.generated.tsx',
  '.pb.go',
  '.pb.gw.go',
  '.snap',
  '.snapshot',
];

const GENERATED_SUFFIXES = [
  '-generated.js',
  '-generated.ts',
  '-generated.tsx',
  '.min.cjs',
  '.min.css',
  '.min.js',
  '.min.mjs',
  '.pb.cc',
  '.pb.h',
  '.pb.rb',
  '_generated.go',
  '_generated.rs',
  '_pb2.py',
  '_pb2_grpc.py',
];

/** @param {string} path */
const getPathParts = (path) => path.replaceAll('\\', '/').split('/').filter(Boolean);

/** @param {string} path */
const isGeneratedWalkthroughPath = (path) => {
  const parts = getPathParts(path).map((part) => part.toLowerCase());
  const basename = parts.at(-1) || '';
  if (!basename) {
    return false;
  }

  return (
    parts.some((part) => GENERATED_DIRECTORY_NAMES.has(part)) ||
    GENERATED_BASENAMES.has(basename) ||
    GENERATED_EXTENSIONS.some((extension) => basename.endsWith(extension)) ||
    GENERATED_SUFFIXES.some((suffix) => basename.endsWith(suffix)) ||
    (basename.endsWith('.map') && !basename.endsWith('.importmap'))
  );
};

/** @param {{generated?: boolean; path: string}} file */
const isGeneratedWalkthroughFile = (file) =>
  file.generated === true || isGeneratedWalkthroughPath(file.path);

/** @param {string} path */
const getGeneratedWalkthroughSummary = (path) => {
  const parts = getPathParts(path).map((part) => part.toLowerCase());
  const basename = parts.at(-1) || '';
  if (GENERATED_BASENAMES.has(basename)) {
    return 'Lockfile collapsed into one generated-file review unit.';
  }
  if (
    parts.includes('__snapshots__') ||
    basename.endsWith('.snap') ||
    basename.endsWith('.snapshot')
  ) {
    return 'Snapshot collapsed into one generated-file review unit.';
  }
  return 'Generated file collapsed into one review unit.';
};

/** @param {string} line */
const parseHunkHeader = (line) => {
  const match = HUNK_HEADER.exec(line);
  if (!match) {
    return null;
  }

  const deletionStart = Number(match[1]);
  const deletionCount = Number(match[2] ?? 1);
  const additionStart = Number(match[3]);
  const additionCount = Number(match[4] ?? 1);

  return {
    additionCount,
    additionEnd: additionStart + Math.max(0, additionCount - 1),
    additionStart,
    deletionCount,
    deletionEnd: deletionStart + Math.max(0, deletionCount - 1),
    deletionStart,
  };
};

/** @param {string} patch */
const extractPatchHunks = (patch) => {
  const lines = typeof patch === 'string' ? patch.split('\n') : [];
  const hunks = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index] ?? '';
    const parsed = parseHunkHeader(header);
    if (!parsed) {
      index += 1;
      continue;
    }

    let additions = 0;
    let deletions = 0;
    index += 1;
    while (index < lines.length && !parseHunkHeader(lines[index] ?? '')) {
      const line = lines[index] ?? '';
      if (line.startsWith('+')) {
        additions += 1;
      } else if (line.startsWith('-')) {
        deletions += 1;
      }
      index += 1;
    }

    hunks.push({
      ...parsed,
      added: additions,
      deleted: deletions,
      header,
    });
  }

  return hunks;
};

/** @param {ReadonlyArray<{added: number; deleted: number}>} hunks */
const sumHunkLineCounts = (hunks) =>
  hunks.reduce(
    (totals, hunk) => ({
      added: totals.added + hunk.added,
      deleted: totals.deleted + hunk.deleted,
    }),
    { added: 0, deleted: 0 },
  );

/** @param {{kind?: string} | null | undefined} hunk */
const isSyntheticWalkthroughHunk = (hunk) => hunk?.kind === 'synthetic';

/** @param {ReturnType<typeof extractPatchHunks>[number] & {kind?: string}} hunk */
const hunkDisplayStart = (hunk) => {
  if (isSyntheticWalkthroughHunk(hunk)) {
    return undefined;
  }

  return hunk.added > 0 ? hunk.additionStart : hunk.deletionStart;
};

/** @param {ReturnType<typeof extractPatchHunks>[number] & {kind?: string}} hunk */
const hunkDisplayEnd = (hunk) => {
  if (isSyntheticWalkthroughHunk(hunk)) {
    return undefined;
  }

  return hunk.added > 0 ? hunk.additionEnd : hunk.deletionEnd;
};

/** @param {string} path @param {ReadonlyArray<ReturnType<typeof extractPatchHunks>[number] & {kind?: string}>} hunks */
const buildAnchorDisplay = (path, hunks) => {
  if (hunks.length === 0) {
    return path;
  }
  const first = hunks[0];
  const last = hunks.at(-1);
  if (!first || !last) {
    return path;
  }
  if (isSyntheticWalkthroughHunk(first)) {
    return path;
  }
  const startLine = hunkDisplayStart(first);
  const endLine = hunkDisplayEnd(last);
  return startLine && endLine && endLine !== startLine
    ? `${path}:${startLine}-${endLine}`
    : `${path}:${startLine || 1}`;
};

/** @param {{oldPath?: string; path: string; status?: string}} file */
const fileHasRenameMetadata = (file) =>
  file.status === 'renamed' && file.oldPath != null && file.oldPath !== file.path;

/**
 * @param {{oldPath?: string; path: string; status?: string}} file
 * @param {{binary?: boolean; loadState?: string; patch?: string; summary?: {reason?: string}}} section
 */
const shouldCreateSyntheticHunk = (file, section) => {
  if (section.binary) {
    return true;
  }
  if (section.loadState != null && section.loadState !== 'ready') {
    return true;
  }
  if (fileHasRenameMetadata(file)) {
    return true;
  }

  return typeof section.patch === 'string' && section.patch.trim().length > 0;
};

/**
 * @param {{generated?: boolean; oldPath?: string; path: string; status: string}} file
 * @param {{binary?: boolean; id: string; kind: string; loadState?: string; patch?: string; summary?: {reason?: string}}} section
 */
const createSyntheticSectionHunk = (file, section, lineCount = { added: 0, deleted: 0 }) => ({
  added: lineCount.added,
  deleted: lineCount.deleted,
  id: `${section.id}:h1`,
  index: 1,
  kind: 'synthetic',
  oldPath: file.oldPath,
  path: file.path,
  sectionId: section.id,
  sectionKind: section.kind,
  status: file.status,
  summary:
    section.summary?.reason ??
    (isGeneratedWalkthroughFile(file) ? getGeneratedWalkthroughSummary(file.path) : undefined),
});

/**
 * Codiff's walkthrough hunk ids identify the smallest reviewable diff unit.
 * Most are textual patch hunks; non-text or metadata-only sections get one
 * synthetic hunk so walkthroughs remain hunk-based for every visible change.
 *
 * @param {{generated?: boolean; oldPath?: string; path: string; status: string}} file
 * @param {{binary?: boolean; id: string; kind: string; loadState?: string; patch?: string; summary?: {reason?: string}}} section
 */
const getSectionWalkthroughHunks = (file, section) => {
  const patchHunks = extractPatchHunks(section.patch || '');
  if (patchHunks.length > 0 && isGeneratedWalkthroughFile(file)) {
    return [createSyntheticSectionHunk(file, section, sumHunkLineCounts(patchHunks))];
  }

  if (patchHunks.length > 0) {
    return patchHunks.map((hunk, index) => ({
      ...hunk,
      id: `${section.id}:h${index + 1}`,
      index: index + 1,
      kind: 'patch',
      oldPath: file.oldPath,
      path: file.path,
      sectionId: section.id,
      sectionKind: section.kind,
      status: file.status,
    }));
  }

  return shouldCreateSyntheticHunk(file, section)
    ? [createSyntheticSectionHunk(file, section)]
    : [];
};

/** @param {string} sectionId @param {string} hunkId */
const getHunkOrdinal = (sectionId, hunkId) => {
  const prefix = `${sectionId}:h`;
  if (!hunkId.startsWith(prefix)) {
    return null;
  }
  const ordinal = Number(hunkId.slice(prefix.length));
  return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : null;
};

/**
 * @param {string} patch
 * @param {string} sectionId
 * @param {ReadonlyArray<string>} hunkIds
 */
const filterPatchToHunkIds = (patch, sectionId, hunkIds) => {
  if (typeof patch !== 'string' || patch.trim().length === 0 || hunkIds.length === 0) {
    return null;
  }

  const patchLines = patch.split('\n');
  const headerLines = [];
  const hunkLinesByOrdinal = new Map();
  let index = 0;
  let foundHunk = false;
  let ordinal = 0;

  while (index < patchLines.length) {
    const parsedHeader = parseHunkHeader(patchLines[index] ?? '');
    if (parsedHeader) {
      foundHunk = true;
      ordinal += 1;
      const hunkStart = index;
      index += 1;
      while (index < patchLines.length && !parseHunkHeader(patchLines[index] ?? '')) {
        index += 1;
      }
      hunkLinesByOrdinal.set(ordinal, patchLines.slice(hunkStart, index));
      continue;
    }

    if (!foundHunk) {
      headerLines.push(patchLines[index] ?? '');
    }
    index += 1;
  }

  if (!foundHunk) {
    return null;
  }

  const selectedHunkLines = [];
  for (const hunkId of hunkIds) {
    const ordinal = getHunkOrdinal(sectionId, hunkId);
    if (ordinal == null) {
      return null;
    }
    const lines = hunkLinesByOrdinal.get(ordinal);
    if (!lines) {
      return null;
    }
    selectedHunkLines.push(...lines);
  }

  if (selectedHunkLines.length === 0) {
    return null;
  }

  const focused = [...headerLines, ...selectedHunkLines].join('\n');
  return patch.endsWith('\n') && !focused.endsWith('\n') ? `${focused}\n` : focused;
};

export {
  buildAnchorDisplay,
  extractPatchHunks,
  filterPatchToHunkIds,
  getSectionWalkthroughHunks,
  HUNK_HEADER,
  hunkDisplayEnd,
  hunkDisplayStart,
  isGeneratedWalkthroughFile,
  isGeneratedWalkthroughPath,
  isSyntheticWalkthroughHunk,
  parseHunkHeader,
  sumHunkLineCounts,
};
