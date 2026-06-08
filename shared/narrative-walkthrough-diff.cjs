// @ts-check

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

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

/** @param {ReturnType<typeof extractPatchHunks>[number]} hunk */
const hunkDisplayStart = (hunk) => (hunk.added > 0 ? hunk.additionStart : hunk.deletionStart);

/** @param {ReturnType<typeof extractPatchHunks>[number]} hunk */
const hunkDisplayEnd = (hunk) => (hunk.added > 0 ? hunk.additionEnd : hunk.deletionEnd);

/** @param {string} path @param {ReadonlyArray<ReturnType<typeof extractPatchHunks>[number]>} hunks */
const buildAnchorDisplay = (path, hunks) => {
  if (hunks.length === 0) {
    return path;
  }
  const first = hunks[0];
  const last = hunks.at(-1);
  if (!first || !last) {
    return path;
  }
  const startLine = hunkDisplayStart(first);
  const endLine = hunkDisplayEnd(last);
  return startLine && endLine && endLine !== startLine
    ? `${path}:${startLine}-${endLine}`
    : `${path}:${startLine || 1}`;
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

module.exports = {
  buildAnchorDisplay,
  extractPatchHunks,
  filterPatchToHunkIds,
  HUNK_HEADER,
  hunkDisplayEnd,
  hunkDisplayStart,
  parseHunkHeader,
  sumHunkLineCounts,
};
