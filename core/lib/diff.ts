import {
  hydratePartialDiff,
  parseDiffFromFile,
  parsePatchFiles,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
} from '@pierre/diffs';
import type { ChangedFile, DiffSection } from '../types.ts';
import type { DiffLineCount } from './app-types.ts';

export const getItemId = (section: DiffSection) => `diff:${section.id}`;

export const isMarkdownFilePath = (path: string) => /\.md$/i.test(path);

export const isImageFilePath = (path: string) =>
  /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|webp)$/i.test(path);

export const canRenderImagePreview = (path: string, section: DiffSection) =>
  isImageFilePath(path) &&
  (section.binary || section.loadState === 'deferred' || section.loadState === 'too-large');

export const isPatchOnlyDiffSection = (section: DiffSection) =>
  section.loadState === 'ready' &&
  !section.binary &&
  section.patch.trim().length > 0 &&
  section.oldFile == null &&
  section.newFile == null;

export const shouldLoadDiffSectionContents = (section: DiffSection) =>
  section.summary?.canLoad !== false && section.loadState === 'deferred';

// Diff search needs full context lines in app state, so it also preloads
// patch-only sections through the eager (state-replacing) flow.
export const shouldPreloadSectionContentsForSearch = (section: DiffSection) =>
  shouldLoadDiffSectionContents(section) ||
  (section.summary?.canLoad !== false && isPatchOnlyDiffSection(section));

// Full file contents fetched lazily for patch-only sections via the CodeView
// `loadDiffFiles` option. Kept outside React state so the library's in-place
// hydration of the rendered diff is not reset by re-renders. Keyed without the
// whitespace flag so re-parses after a whitespace toggle reuse the contents.
const getLoadedContentsKey = (file: ChangedFile, section: DiffSection) =>
  `${file.fingerprint}:${section.id}:${getSectionCacheIdentity(section)}`;

const loadedSectionContents = new Map<string, FileDiffLoadedFiles>();
const pendingSectionLoads = new Map<string, Promise<FileDiffLoadedFiles>>();

const fileDiffSectionLookup = new WeakMap<
  FileDiffMetadata,
  { file: ChangedFile; section: DiffSection }
>();

export const getSectionForFileDiff = (fileDiff: FileDiffMetadata) =>
  fileDiffSectionLookup.get(fileDiff);

export const getLoadedSectionContents = (file: ChangedFile, section: DiffSection) =>
  loadedSectionContents.get(getLoadedContentsKey(file, section));

export const loadSectionContents = (
  file: ChangedFile,
  section: DiffSection,
  load: (file: ChangedFile, section: DiffSection) => Promise<FileDiffLoadedFiles>,
): Promise<FileDiffLoadedFiles> => {
  const key = getLoadedContentsKey(file, section);
  const loaded = loadedSectionContents.get(key);
  if (loaded) {
    return Promise.resolve(loaded);
  }

  const pending = pendingSectionLoads.get(key);
  if (pending) {
    return pending;
  }

  const promise = load(file, section)
    .then((files) => {
      // CodeView hydrates the cached partial object in place once these
      // contents reach it, so cache hits keep returning the hydrated diff.
      // The hydrated re-parse branch in `parseSectionDiffWithOptions` covers
      // re-parses under a different cache key (e.g. a whitespace toggle).
      loadedSectionContents.set(key, files);
      return files;
    })
    .finally(() => {
      pendingSectionLoads.delete(key);
    });
  pendingSectionLoads.set(key, promise);
  return promise;
};

const joinDiffLines = (lines: ReadonlyArray<string>) =>
  lines.some((line) => line.includes('\n')) ? lines.join('') : lines.join('\n');

export type MarkdownPreviewContents = {
  addedLines: ReadonlySet<number>;
  contents: string;
};

const emptyAddedLines = new Set<number>();

const getAddedLineNumbers = (
  file: ChangedFile,
  fileDiff: FileDiffMetadata,
): ReadonlySet<number> => {
  if (file.status === 'added' || file.status === 'untracked') {
    return emptyAddedLines;
  }

  const addedLines = new Set<number>();

  for (const hunk of fileDiff.hunks) {
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        additionLineNumber += content.lines;
        continue;
      }

      for (let index = 0; index < content.additions; index += 1) {
        addedLines.add(additionLineNumber + index);
      }

      additionLineNumber += content.additions;
    }
  }

  return addedLines;
};

export const getMarkdownPreviewContents = (
  file: ChangedFile,
  section: DiffSection,
  fileDiff: FileDiffMetadata,
): MarkdownPreviewContents | null => {
  if (!isMarkdownFilePath(file.path) || section.binary || section.loadState !== 'ready') {
    return null;
  }

  const newFile = section.newFile ?? getLoadedSectionContents(file, section)?.newFile;
  if (newFile) {
    return {
      addedLines: getAddedLineNumbers(file, fileDiff),
      contents: newFile.contents,
    };
  }

  return file.status === 'added' || file.status === 'untracked'
    ? {
        addedLines: emptyAddedLines,
        contents: joinDiffLines(fileDiff.additionLines),
      }
    : null;
};

const emptyDiffLineCount: DiffLineCount = {
  additions: 0,
  countable: false,
  deletions: 0,
};

export const getDiffLineCountFromVisibleSections = (
  sections: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    section: DiffSection;
  }>,
): DiffLineCount => {
  let additions = 0;
  let countable = false;
  let deletions = 0;

  for (const { fileDiff, section } of sections) {
    if (section.binary || (section.loadState != null && section.loadState !== 'ready')) {
      continue;
    }

    countable = true;
    for (const hunk of fileDiff.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
  }

  return countable
    ? {
        additions,
        countable,
        deletions,
      }
    : emptyDiffLineCount;
};

export const getDiffLineCount = (file: ChangedFile, showWhitespace: boolean): DiffLineCount =>
  getDiffLineCountFromVisibleSections(getVisibleDiffSections(file, showWhitespace));

export const getTotalDiffLineCount = (lineCounts: Iterable<DiffLineCount>): DiffLineCount => {
  let additions = 0;
  let countable = false;
  let deletions = 0;

  for (const lineCount of lineCounts) {
    if (!lineCount.countable) {
      continue;
    }

    additions += lineCount.additions;
    countable = true;
    deletions += lineCount.deletions;
  }

  return countable
    ? {
        additions,
        countable,
        deletions,
      }
    : emptyDiffLineCount;
};

export const formatLineCountNumber = (value: number) => value.toLocaleString('en-US');

export const formatCompactLineCountNumber = (value: number) => {
  if (value < 1000) {
    return String(value);
  }

  if (value < 10_000) {
    return `${Number((value / 1000).toFixed(1))}k`;
  }

  if (value < 1_000_000) {
    return `${Math.round(value / 1000)}k`;
  }

  return `${Number((value / 1_000_000).toFixed(1))}m`;
};

export const formatTreeLineCount = ({ additions, deletions }: DiffLineCount) =>
  `+${formatCompactLineCountNumber(additions)} -${formatCompactLineCountNumber(deletions)}`;

export const pluralizeLine = (count: number) => (count === 1 ? 'line' : 'lines');

export const getDiffLineCountTitle = ({ additions, deletions }: DiffLineCount) =>
  `${formatLineCountNumber(additions)} added ${pluralizeLine(
    additions,
  )}, ${formatLineCountNumber(deletions)} removed ${pluralizeLine(deletions)}`;

const createBinaryFileDiff = (file: ChangedFile, section: DiffSection): FileDiffMetadata => ({
  additionLines: [`${section.summary?.reason ?? 'Binary file changed.'}\n`],
  cacheKey: `summary:${file.fingerprint}:${section.id}:${section.loadState ?? 'binary'}:${
    section.summary?.reason ?? ''
  }`,
  deletionLines: [],
  hunks: [
    {
      additionCount: 1,
      additionLineIndex: 0,
      additionLines: 1,
      additionStart: 1,
      collapsedBefore: 0,
      deletionCount: 0,
      deletionLineIndex: 0,
      deletionLines: 0,
      deletionStart: 0,
      hunkContent: [
        {
          additionLineIndex: 0,
          additions: 1,
          deletionLineIndex: 0,
          deletions: 0,
          type: 'change',
        },
      ],
      hunkSpecs: '@@ -0,0 +1 @@\n',
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
      splitLineCount: 1,
      splitLineStart: 0,
      unifiedLineCount: 1,
      unifiedLineStart: 0,
    },
  ],
  isPartial: true,
  name: file.path,
  prevName: file.oldPath,
  splitLineCount: 1,
  type: file.status === 'deleted' ? 'deleted' : file.status === 'added' ? 'new' : 'change',
  unifiedLineCount: 1,
});

const createEmptyFileDiff = (file: ChangedFile, section: DiffSection): FileDiffMetadata => ({
  additionLines: section.newFile?.contents.split('\n') ?? [],
  cacheKey: `empty:${file.fingerprint}:${section.id}`,
  deletionLines: section.oldFile?.contents.split('\n') ?? [],
  hunks: [],
  isPartial: false,
  name: section.newFile?.name ?? file.path,
  prevName: section.oldFile?.name ?? file.oldPath,
  splitLineCount: 0,
  type: file.status === 'deleted' ? 'deleted' : file.status === 'added' ? 'new' : 'change',
  unifiedLineCount: 0,
});

const parsedDiffCache = new Map<string, FileDiffMetadata>();

const getSectionCacheIdentity = (section: DiffSection) =>
  [
    section.loadState ?? 'ready',
    section.summary?.reason ?? '',
    section.summary?.fingerprint ?? '',
    section.oldFile?.cacheKey ?? '',
    section.newFile?.cacheKey ?? '',
    section.patch.length,
  ].join(':');

export const parseSectionDiffWithOptions = (
  file: ChangedFile,
  section: DiffSection,
  showWhitespace: boolean,
): FileDiffMetadata => {
  const cacheKey = `${file.fingerprint}:${section.id}:${getSectionCacheIdentity(section)}:${
    showWhitespace ? 'ws' : 'ignore-ws'
  }`;
  const cached = parsedDiffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let fileDiff: FileDiffMetadata;
  if (section.binary || (section.loadState != null && section.loadState !== 'ready')) {
    fileDiff = createBinaryFileDiff(file, section);
  } else if (section.oldFile && section.newFile) {
    try {
      fileDiff = {
        ...parseDiffFromFile(section.oldFile, section.newFile, {
          ignoreWhitespace: !showWhitespace,
        }),
        cacheKey,
      };
    } catch {
      fileDiff = createEmptyFileDiff(file, section);
    }
  } else if (section.patch.trim().length === 0) {
    fileDiff = createEmptyFileDiff(file, section);
  } else {
    const parsedFileDiff = parsePatchFiles(section.patch)[0]?.files[0];
    if (parsedFileDiff) {
      const loaded = parsedFileDiff.isPartial ? getLoadedSectionContents(file, section) : undefined;
      let hydrated: FileDiffMetadata | null = null;
      if (loaded) {
        try {
          // A fresh parse under a new cache key (e.g. a whitespace toggle)
          // starts partial again even though contents were already fetched.
          // Hydrate it with the library's own routine so the hunk geometry
          // matches what CodeView produced when it hydrated the previous
          // object in place after a `loadDiffFiles` expansion.
          hydrated = hydratePartialDiff('merge', parsedFileDiff, loaded);
        } catch {
          hydrated = null;
        }
      }

      if (hydrated) {
        fileDiff = hydrated;
      } else {
        fileDiff = {
          ...parsedFileDiff,
          cacheKey,
        };
        // CodeView hydrates this object in place when the user expands
        // unchanged context, so the cache key must derive from section
        // identity and keep returning the same object. Binary/summary
        // placeholders are intentionally never registered; they must not be
        // hydrated.
        if (section.summary?.canLoad !== false) {
          fileDiffSectionLookup.set(fileDiff, { file, section });
        }
      }
    } else {
      fileDiff = createBinaryFileDiff(file, section);
    }
  }

  parsedDiffCache.set(cacheKey, fileDiff);
  return fileDiff;
};

const modeMetadataPattern = /^(?:old mode|new mode|new file mode|deleted file mode) /m;

const fileHasMetadataDiff = (file: ChangedFile, section: DiffSection) =>
  modeMetadataPattern.test(section.patch) ||
  (file.status === 'renamed' && file.oldPath != null && file.oldPath !== file.path);

const sectionHasVisibleDiff = (
  file: ChangedFile,
  section: DiffSection,
  fileDiff: FileDiffMetadata,
) =>
  section.binary ||
  (section.loadState != null && section.loadState !== 'ready') ||
  fileHasMetadataDiff(file, section) ||
  fileDiff.hunks.length > 0;

export const getVisibleDiffSections = (file: ChangedFile, showWhitespace: boolean) =>
  file.sections
    .map((section) => ({
      fileDiff: parseSectionDiffWithOptions(file, section, showWhitespace),
      section,
    }))
    .filter(({ fileDiff, section }) => sectionHasVisibleDiff(file, section, fileDiff));

export const fileHasVisibleDiff = (file: ChangedFile, showWhitespace: boolean) =>
  getVisibleDiffSections(file, showWhitespace).length > 0;

export const getFirstVisibleSection = (file: ChangedFile, showWhitespace: boolean) =>
  getVisibleDiffSections(file, showWhitespace)[0]?.section;
