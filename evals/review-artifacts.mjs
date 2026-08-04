import { createHash } from 'node:crypto';
import {
  filterPatchToHunkIds,
  getSectionWalkthroughHunks,
} from '../core/lib/narrative-walkthrough-diff.js';

const defaultPreferences = Object.freeze({
  codeFontFamily: 'Fira Code',
  codeFontSize: 13,
  diffStyle: 'split',
  showWhitespace: false,
  theme: 'system',
  wordWrap: false,
});

const requireRecord = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
};

const requireString = (value, name) => {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
};

const hunkIdentity = (hunk, patchContent) =>
  [
    hunk.path,
    hunk.status,
    hunk.kind,
    hunk.deletionStart,
    hunk.deletionEnd,
    hunk.additionStart,
    hunk.additionEnd,
    hunk.added,
    hunk.deleted,
    hunk.header,
    createHash('sha256').update(patchContent).digest('hex'),
  ].join('\u0000');

const indexHunks = (files) => {
  const identitiesById = new Map();
  const idsByIdentity = new Map();
  for (const file of files) {
    for (const section of file.sections) {
      for (const hunk of getSectionWalkthroughHunks(file, section)) {
        const identity = hunkIdentity(
          hunk,
          filterPatchToHunkIds(section.patch, section.id, [hunk.id]),
        );
        identitiesById.set(hunk.id, identity);
        const ids = idsByIdentity.get(identity) ?? [];
        ids.push(hunk.id);
        idsByIdentity.set(identity, ids);
      }
    }
  }
  return { identitiesById, idsByIdentity };
};

const omitArtifact = Symbol('omit-artifact');

const mapArtifact = (value, transform, key = '') => {
  const transformed = transform(value, key);
  if (transformed === omitArtifact) {
    return omitArtifact;
  }
  if (Array.isArray(transformed)) {
    return transformed.flatMap((item) => {
      const mapped = mapArtifact(item, transform);
      return mapped === omitArtifact ? [] : [mapped];
    });
  }
  if (transformed && typeof transformed === 'object') {
    const entries = [];
    for (const [entryKey, item] of Object.entries(transformed)) {
      const mapped = mapArtifact(item, transform, entryKey);
      if (mapped === omitArtifact) {
        return omitArtifact;
      }
      entries.push([entryKey, mapped]);
    }
    return Object.fromEntries(entries);
  }
  return transformed;
};

export const remapWalkthroughHunks = ({ fromFiles, toFiles, walkthrough }) => {
  const source = indexHunks(fromFiles);
  const local = indexHunks(toFiles);
  const aliases = new Map();
  for (const [sourceId, identity] of source.identitiesById) {
    const localIds = local.idsByIdentity.get(identity);
    if (localIds?.length === 1) {
      aliases.set(sourceId, localIds[0]);
    }
  }
  const remap = (value, key) => {
    if (key === 'hunkId' && typeof value === 'string') {
      return aliases.get(value) ?? omitArtifact;
    }
    if (key === 'hunkIds' && Array.isArray(value)) {
      return value.flatMap((hunkId) => {
        const alias = aliases.get(hunkId);
        return alias ? [alias] : [];
      });
    }
    return value;
  };
  const remapped = mapArtifact(walkthrough, remap);
  if (remapped === omitArtifact) {
    throw new Error('Walkthrough hunk remapping removed the root artifact.');
  }
  if (remapped?.capturedContext && Array.isArray(remapped.capturedContext.files)) {
    return {
      ...remapped,
      capturedContext: { ...remapped.capturedContext, files: toFiles },
    };
  }
  return remapped;
};

const normalizeLocalPath = (value) => {
  const normalized = value.replaceAll('\\', '/');
  const prefix = normalized.startsWith('//') ? '//' : '';
  return prefix + normalized.slice(prefix.length).replaceAll(/\/{2,}/g, '/');
};
const localPathKey = (value) => (/^(?:[a-z]:\/|\/\/)/i.test(value) ? value.toLowerCase() : value);
const escapeRegularExpression = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const scrubEmbeddedLocalRoot = (value, localRoot, replacement) => {
  const normalizedRoot = normalizeLocalPath(localRoot).replace(/\/$/, '');
  const variants = new Set([
    localRoot.replace(/[\\/]$/, ''),
    normalizedRoot,
    normalizedRoot.replaceAll('/', '\\'),
  ]);
  let scrubbed = value;
  for (const variant of [...variants].filter(Boolean).toSorted((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.replaceAll(new RegExp(escapeRegularExpression(variant), 'gi'), replacement);
  }
  return scrubbed;
};

const scrubLocalPaths = (value, localRoots, replacement) => {
  if (typeof value === 'string') {
    const normalizedValue = normalizeLocalPath(value);
    const valueKey = localPathKey(normalizedValue);
    for (const localRoot of localRoots) {
      const normalizedRoot = normalizeLocalPath(localRoot).replace(/\/$/, '');
      const rootKey = localPathKey(normalizedRoot);
      if (valueKey === rootKey) {
        return replacement;
      }
      if (valueKey.startsWith(`${rootKey}/`)) {
        return `${replacement}/${normalizedValue.slice(normalizedRoot.length + 1)}`;
      }
    }
    return localRoots.reduce(
      (scrubbed, localRoot) => scrubEmbeddedLocalRoot(scrubbed, localRoot, replacement),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubLocalPaths(item, localRoots, replacement));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        scrubLocalPaths(item, localRoots, replacement),
      ]),
    );
  }
  return value;
};

export const buildEvalShareManifest = ({ artifactId, reviewScope, state, walkthrough }) => {
  requireString(artifactId, 'eval artifact id');
  const evalRoot = `eval:${artifactId}`;
  const localRoots = [state.root, state.launchPath].filter(
    (value, index, values) => typeof value === 'string' && value && values.indexOf(value) === index,
  );
  const scrubbedWalkthrough = scrubLocalPaths(walkthrough, localRoots, evalRoot);
  if (scrubbedWalkthrough?.repo && typeof scrubbedWalkthrough.repo === 'object') {
    scrubbedWalkthrough.repo.root = evalRoot;
  }
  const source = scrubLocalPaths(state.source, localRoots, evalRoot);
  const manifest = {
    branch: state.branch,
    codiffVersion: 'eval',
    exportedAt: new Date(state.generatedAt).toISOString(),
    files: state.files,
    kind: 'codiff-walkthrough-share',
    preferences: defaultPreferences,
    repository: {
      root: evalRoot,
      source,
      ...(source?.type === 'pull-request' && source.title ? { title: source.title } : {}),
    },
    ...(state.reviewComments?.length
      ? { reviewComments: scrubLocalPaths(state.reviewComments, localRoots, evalRoot) }
      : {}),
    ...(reviewScope ? { reviewScope } : {}),
    version: 1,
    walkthrough: scrubbedWalkthrough,
  };
  return assertEvalShareManifest(manifest);
};

/**
 * @typedef {
 *   | {baseBranch: string, headBranch: string, symmetric: boolean, type: 'range'}
 *   | {baseRevision: string, headRevision: string, symmetric: boolean, type: 'range'}
 * } ScenarioReviewSource
 */

/**
 * @param {{
 *   baseBranch?: string,
 *   featureBranch?: string,
 *   materialized: {revisions: Record<string, string>},
 *   scenarioId: string,
 *   source?: ScenarioReviewSource,
 * }} options
 */
export const buildScenarioReviewTarget = ({
  baseBranch = 'main',
  featureBranch = 'feature/test-scenario',
  materialized,
  scenarioId,
  source = { baseBranch, headBranch: featureBranch, symmetric: false, type: 'range' },
}) =>
  assertScenarioReviewTarget({
    materialization: { baseBranch, featureBranch, scenarioId },
    revisions: materialized.revisions,
    source,
    version: 1,
  });

/**
 * @param {{
 *   materialized: {revisions: Record<string, string>},
 *   source: ScenarioReviewSource,
 * }} options
 */
export const resolveScenarioReviewRange = ({ materialized, source }) => {
  const revisions = requireRecord(materialized?.revisions, 'materialized.revisions');
  const base = 'baseRevision' in source ? revisions[source.baseRevision] : source.baseBranch;
  const head = 'headRevision' in source ? revisions[source.headRevision] : source.headBranch;
  if (!base || !head) {
    throw new Error('The recorded scenario range could not be resolved after materialization.');
  }
  return { base, head, symmetric: source.symmetric };
};

const canonicalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

export const computeFixtureDigest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');

export const assertEvalAttemptMeta = (meta) => {
  const value = requireRecord(meta, 'eval attempt metadata');
  requireString(value.exitStatus, 'eval attempt exit status');
  requireString(value.variant, 'eval attempt variant');
  if (!Number.isFinite(value.generationMs) || value.generationMs < 0) {
    throw new Error('Eval attempt generation time must be a non-negative number.');
  }
  if (!Number.isInteger(value.modelCalls) || value.modelCalls < 0) {
    throw new Error('Eval attempt model call count must be a non-negative integer.');
  }
  if (!Number.isFinite(value.stateMs) || value.stateMs < 0) {
    throw new Error('Eval attempt state time must be a non-negative number.');
  }
  if (!Number.isFinite(value.promptChars) || value.promptChars < 0) {
    throw new Error('Eval attempt prompt size must be a non-negative number.');
  }
  if (typeof value.fixtureDigest !== 'string' || !/^[a-f\d]{64}$/.test(value.fixtureDigest)) {
    throw new Error('Eval attempt fixture digest must be a SHA-256 hex digest.');
  }
  return meta;
};

export const assertEvalContract = (contract) => {
  const value = requireRecord(contract, 'eval contract');
  if (typeof value.pass !== 'boolean') {
    throw new Error('Eval contract pass must be a boolean.');
  }
  if (
    !Array.isArray(value.failures) ||
    value.failures.some((failure) => typeof failure !== 'string' || !failure)
  ) {
    throw new Error('Eval contract failures must be an array of non-empty strings.');
  }
  if (value.pass !== (value.failures.length === 0)) {
    throw new Error('Eval contract pass must agree with its failures.');
  }
  if (value.metrics != null) {
    const metrics = requireRecord(value.metrics, 'eval contract metrics');
    if (Object.values(metrics).some((metric) => !Number.isFinite(metric))) {
      throw new Error('Eval contract metrics must contain only finite numbers.');
    }
  }
  return contract;
};

export const assertEvalShareManifest = (manifest) => {
  const value = requireRecord(manifest, 'share manifest');
  if (value.kind !== 'codiff-walkthrough-share' || value.version !== 1) {
    throw new Error('The share manifest must be a version 1 codiff walkthrough share.');
  }
  if (!Array.isArray(value.files)) {
    throw new Error('The share manifest files must be an array.');
  }
  if (value.branch != null && typeof value.branch !== 'string') {
    throw new Error('The share manifest branch must be a string or null.');
  }
  requireString(value.codiffVersion, 'share manifest Codiff version');
  requireString(value.exportedAt, 'share manifest export timestamp');
  if (Number.isNaN(Date.parse(value.exportedAt))) {
    throw new Error('The share manifest export timestamp must be valid.');
  }
  requireRecord(value.preferences, 'share manifest preferences');
  const repository = requireRecord(value.repository, 'share manifest repository');
  requireString(repository.root, 'share manifest repository root');
  requireRecord(repository.source, 'share manifest repository source');
  const walkthrough = requireRecord(value.walkthrough, 'share manifest walkthrough');
  if (value.reviewComments != null && !Array.isArray(value.reviewComments)) {
    throw new Error('The share manifest review comments must be an array.');
  }
  if (
    walkthrough.repo &&
    requireRecord(walkthrough.repo, 'share manifest walkthrough repository').root !==
      repository.root
  ) {
    throw new Error('The share manifest must use one scrubbed repository root.');
  }
  if (value.reviewScope) {
    const scope = requireRecord(value.reviewScope, 'share manifest review scope');
    requireString(scope.kind, 'share manifest review scope kind');
    requireString(scope.structure, 'share manifest review scope structure');
  }
  return manifest;
};

export const assertScenarioReviewTarget = (target) => {
  const value = requireRecord(target, 'review target');
  if (value.version !== 1) {
    throw new Error('The review target must be version 1.');
  }
  const materialization = requireRecord(value.materialization, 'review target materialization');
  requireString(materialization.scenarioId, 'review target scenario id');
  requireString(materialization.baseBranch, 'review target base branch');
  requireString(materialization.featureBranch, 'review target feature branch');
  const revisions = requireRecord(value.revisions, 'review target revisions');
  if (Object.values(revisions).some((revision) => typeof revision !== 'string' || !revision)) {
    throw new Error('Review target revisions must contain only non-empty strings.');
  }
  const source = requireRecord(value.source, 'review target source');
  if (source.type !== 'range' || typeof source.symmetric !== 'boolean') {
    throw new Error('The review target must describe a range source.');
  }
  const namedRevisions =
    typeof source.baseRevision === 'string' && typeof source.headRevision === 'string';
  const branches = typeof source.baseBranch === 'string' && typeof source.headBranch === 'string';
  if (!namedRevisions && !branches) {
    throw new Error('The review target range must use named revisions or branches.');
  }
  if (namedRevisions && (!revisions[source.baseRevision] || !revisions[source.headRevision])) {
    throw new Error('The review target named range must resolve through its revisions.');
  }
  return target;
};
