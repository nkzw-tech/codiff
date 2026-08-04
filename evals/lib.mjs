import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { getSectionWalkthroughHunks } = require('../core/lib/narrative-walkthrough-diff.cjs');

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const runsRoot = join(root, 'evals', 'runs');

export const nowMs = () => performance.now();
export const roundMs = (value) => Math.round(value * 10) / 10;

const adaptersRoot = new URL('./adapters/', import.meta.url);
const defaultAdapter = './adapters/single-commit.mjs';

export const readCases = async () => {
  const cases = JSON.parse(await readFile(join(root, 'evals', 'cases.json'), 'utf8'));
  if (!Array.isArray(cases)) {
    throw new Error('evals/cases.json must contain an array.');
  }
  const normalized = cases.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !/^[a-z\d]+(?:-[a-z\d]+)*$/.test(item.id) ||
      !Array.isArray(item.rubric) ||
      item.rubric.some((entry) => typeof entry !== 'string' || !entry)
    ) {
      throw new Error('Each eval case requires a lowercase kebab-case id and rubric array.');
    }
    const kind = item.kind ?? 'single-commit';
    const adapter = item.adapter ?? (kind === 'single-commit' ? defaultAdapter : null);
    if (
      typeof kind !== 'string' ||
      !/^[a-z\d]+(?:-[a-z\d]+)*$/.test(kind) ||
      typeof adapter !== 'string' ||
      !adapter
    ) {
      throw new Error(`Eval case ${item.id} requires a kind and adapter.`);
    }
    if (kind === 'single-commit' && (typeof item.commit !== 'string' || !item.commit)) {
      throw new Error(`Single-commit eval case ${item.id} requires a commit.`);
    }
    return { ...item, adapter, kind };
  });
  const ids = new Set(normalized.map((item) => item.id));
  if (ids.size !== normalized.length) {
    throw new Error('Eval case ids must be unique.');
  }
  return normalized;
};

export const loadCaseAdapter = async (evalCase, requiredExport) => {
  const adapterUrl = new URL(evalCase.adapter, import.meta.url);
  if (
    !adapterUrl.href.startsWith(adaptersRoot.href) ||
    !adapterUrl.pathname.endsWith('.mjs') ||
    pathToFileURL(fileURLToPath(adapterUrl)).href !== adapterUrl.href
  ) {
    throw new Error(`Eval case ${evalCase.id} uses an invalid adapter path.`);
  }
  const adapter = await import(adapterUrl.href);
  if (adapter.kind !== evalCase.kind) {
    throw new Error(
      `Eval adapter ${evalCase.adapter} declares ${String(adapter.kind)} instead of ${evalCase.kind}.`,
    );
  }
  if (typeof adapter[requiredExport] !== 'function') {
    throw new Error(`Eval adapter ${evalCase.adapter} does not export ${requiredExport}().`);
  }
  return adapter;
};

export const resolveRunDir = (label) => resolve(runsRoot, label);

export const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const initializeEvalRun = async ({ label, metadata, runDir }) => {
  await mkdir(dirname(runDir), { recursive: true });
  try {
    await mkdir(runDir);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `Eval run label ${JSON.stringify(label)} already exists. Choose a new label to keep suites and attempts isolated.`,
      );
    }
    throw error;
  }
  await writeJson(join(runDir, 'run.json'), metadata);
};

/**
 * @param {ReadonlyArray<{sections: ReadonlyArray<unknown>}>} files
 * @returns {Array<string>}
 */
export const collectHunkIds = (files) =>
  files.flatMap((file) =>
    file.sections.flatMap((section) =>
      getSectionWalkthroughHunks(file, section).map((hunk) => hunk.id),
    ),
  );

export const narrativeContents = (walkthrough) => {
  const contents = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (Array.isArray(value.chapters)) {
      contents.push(value);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(walkthrough);
  return contents;
};

const flattenWalkthroughGroups = (walkthrough) =>
  narrativeContents(walkthrough).flatMap((content) => [
    ...content.chapters.flatMap((chapter) => chapter.stops),
    ...(content.support || []),
  ]);

export const getWalkthroughMetrics = (state, walkthrough) => {
  const allHunkIds = collectHunkIds(state.files);
  const knownHunkIds = new Set(allHunkIds);
  const contents = narrativeContents(walkthrough);
  const chapters = contents.flatMap((content) => content.chapters);
  const mainHunkIds = chapters.flatMap((chapter) => chapter.stops.flatMap((stop) => stop.hunkIds));
  const supportHunkIds = contents.flatMap((content) =>
    (content.support || []).flatMap((item) => item.hunkIds),
  );
  const referencedHunkIds = [...mainHunkIds, ...supportHunkIds];
  const uniqueReferencedHunkIds = new Set(referencedHunkIds);
  const unknownHunkIds = [...uniqueReferencedHunkIds].filter((id) => !knownHunkIds.has(id));
  const duplicateReferenceCount = referencedHunkIds.length - uniqueReferencedHunkIds.size;
  const proseChars = chapters.reduce(
    (total, chapter) =>
      total +
      chapter.blurb.length +
      chapter.stops.reduce(
        (stopTotal, stop) =>
          stopTotal +
          stop.prose.length +
          (stop.summary?.length || 0) +
          (stop.notes || []).reduce((noteTotal, note) => noteTotal + note.body.length, 0),
        0,
      ),
    0,
  );

  return {
    chapterCount: chapters.length,
    duplicateReferenceCount,
    groupCount: flattenWalkthroughGroups(walkthrough).length,
    hunkCount: allHunkIds.length,
    mainCoverage: allHunkIds.length === 0 ? 0 : mainHunkIds.length / allHunkIds.length,
    mainHunkCount: mainHunkIds.length,
    proseChars,
    stopCount: chapters.reduce((total, chapter) => total + chapter.stops.length, 0),
    supportHunkCount: supportHunkIds.length,
    totalCoverage: allHunkIds.length === 0 ? 0 : uniqueReferencedHunkIds.size / allHunkIds.length,
    unknownHunkIds,
  };
};

export const listAttemptDirs = async (runDir, caseId) => {
  const caseDir = join(runDir, caseId);
  const entries = await readdir(caseDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('attempt-'))
    .map((entry) => join(caseDir, entry.name))
    .sort();
};

export const median = (values) => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

export const average = (values) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

export const readJson = async (path, fallback = null) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
};
