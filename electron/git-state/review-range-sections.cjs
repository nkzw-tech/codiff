// @ts-check

const { createSummary, getFingerprint, summarizeContent } = require('./common.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/lib/review-artifacts.ts').ArtifactFile} ArtifactFile
 */

/**
 * git and forge APIs emit `Binary files a/x and b/x differ` as diff metadata.
 * Anchor to the start of a line so the same text inside an added, removed, or
 * context line does not misclassify a textual patch as binary.
 *
 * @param {string} patch
 */
const isBinaryDiffPatch = (patch) => /^Binary files .* differ/m.test(patch);

/**
 * A provider may omit a textual patch while still supplying immutable blob
 * identities. Keep those files loadable; an absent patch alone is not proof
 * that the file is binary.
 *
 * @param {ArtifactFile} file
 */
const canHydrateArtifactFile = (file) =>
  Boolean(file.patch || file.oldObjectId || file.newObjectId);

/**
 * A bounded provider response can leave a Range Artifact with incomplete file
 * coverage. Keep that distinct from a complete range: the renderer needs one
 * visible warning rather than a file tree that falsely suggests every change
 * is present.
 *
 * @param {import('../../core/lib/review-artifacts.ts').RangeArtifact} artifact
 * @param {number} number
 * @returns {ChangedFile}
 */
const createCoverageWarningFile = (artifact, number) => {
  const partiallyAvailable = artifact.files.length > 0;
  const warningKind = partiallyAvailable ? 'incomplete' : 'unavailable';
  const warningLabel = partiallyAvailable ? 'Review diff incomplete' : 'Review diff unavailable';
  const existingPaths = new Set(artifact.files.map((file) => file.path));
  let warningPath = warningLabel;
  let suffix = 2;
  while (existingPaths.has(warningPath)) {
    warningPath = `${warningLabel} (${suffix})`;
    suffix += 1;
  }
  return {
    fingerprint: getFingerprint(
      `${artifact.baseSha}:${artifact.headSha}:review-range-${warningKind}:${artifact.incompleteReason ?? ''}`,
    ),
    path: warningPath,
    sections: [
      {
        binary: false,
        id: `review-range-${warningKind}:${number}`,
        kind: 'pull-request',
        loadState: 'error',
        patch: '',
        // Deliberately omit range coordinates: this is evidence about the
        // whole review, not a provider file that can accept a comment target.
        summary: createSummary(
          artifact.incompleteReason ??
            (partiallyAvailable
              ? 'Codiff could not load the complete review diff, so some changed files may be missing.'
              : 'Codiff could not load a complete review diff, so changed files are unavailable.'),
          { canLoad: false },
        ),
      },
    ],
    status: 'modified',
  };
};

/**
 * Project a provider-normalized Range Artifact into the review renderer shape
 * without rebuilding provider diff semantics in Electron.
 *
 * @param {import('../../core/lib/review-artifacts.ts').RangeArtifact} artifact
 * @param {number} number
 * @param {{deferContents?: boolean}} [options]
 * @returns {ReadonlyArray<ChangedFile>}
 */
const rangeArtifactToPullRequestFiles = (artifact, number, options = {}) => {
  const files = artifact.files.map((file, index) => {
    const patch = file.patch || '';
    const binary = isBinaryDiffPatch(patch);
    const patchUnavailable = !patch && !canHydrateArtifactFile(file);
    const deferContents = options.deferContents === true && canHydrateArtifactFile(file) && !binary;
    return {
      fingerprint: getFingerprint(
        `${artifact.baseSha}:${artifact.headSha}:${index}:${file.path}:${file.status}:${patch}`,
      ),
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      path: file.path,
      sections: [
        {
          binary,
          id: `${file.path}:pull-request:${number}`,
          kind: 'pull-request',
          loadState: patchUnavailable
            ? 'error'
            : binary
              ? 'binary'
              : deferContents
                ? 'deferred'
                : 'ready',
          patch,
          range: {
            base: {
              label: { kind: 'commit', text: artifact.baseSha.slice(0, 7) },
              sha: artifact.baseSha,
            },
            head: {
              label: { kind: 'commit', text: artifact.headSha.slice(0, 7) },
              sha: artifact.headSha,
            },
          },
          summary: createSummary(
            patchUnavailable
              ? 'The provider did not return a patch or immutable content identity for this file.'
              : binary
                ? 'Binary file changed.'
                : deferContents && !patch
                  ? 'The provider omitted the textual patch; exact file contents load on demand.'
                  : deferContents
                    ? 'Showing the provider patch while exact file contents load on demand.'
                    : 'Showing the provider patch for this file.',
            { canLoad: deferContents },
          ),
        },
      ],
      status: file.status,
    };
  });
  return artifact.coverage === 'complete'
    ? files
    : [...files, createCoverageWarningFile(artifact, number)];
};

/**
 * Build a pull-request section from one canonical ArtifactFile. When both
 * contents are present, Codiff can render an expandable recomputed diff;
 * otherwise it retains the provider patch.
 *
 * @param {{number: number}} pullRequest
 * @param {ArtifactFile} file
 * @param {import('./common.cjs').FileContentResult} [oldFile]
 * @param {import('./common.cjs').FileContentResult} [newFile]
 * @param {{base?: string, contentAttempted?: boolean, contentError?: string, deferContents?: boolean, head?: string}} [rangeRefs]
 * @returns {import('../../core/types.ts').DiffSection}
 */
const createPullRequestSection = (pullRequest, file, oldFile, newFile, rangeRefs = {}) => {
  const patch = file.patch || '';
  const id = `${file.path}:pull-request:${pullRequest.number}`;
  const patchBinary = isBinaryDiffPatch(patch);
  const contentLoadable = canHydrateArtifactFile(file);
  const patchUnavailable = !patch && !contentLoadable;
  const range =
    rangeRefs.base && rangeRefs.head
      ? {
          base: {
            sha: rangeRefs.base,
            label: { kind: 'commit', text: rangeRefs.base.slice(0, 7) },
          },
          head: {
            sha: rangeRefs.head,
            label: { kind: 'commit', text: rangeRefs.head.slice(0, 7) },
          },
        }
      : undefined;
  const attemptedContent = oldFile != null && newFile != null;
  const contentAttempted = rangeRefs.contentAttempted === true || attemptedContent;

  if (rangeRefs.deferContents && contentLoadable && !patchBinary) {
    return {
      binary: false,
      id,
      kind: 'pull-request',
      loadState: 'deferred',
      patch,
      ...(range ? { range } : {}),
      summary: createSummary(
        patch
          ? 'Showing the provider patch while exact file contents load on demand.'
          : 'The provider omitted the textual patch; exact file contents load on demand.',
        { canLoad: true },
      ),
    };
  }

  if (rangeRefs.contentError && contentLoadable && !patchBinary) {
    return {
      binary: false,
      id,
      kind: 'pull-request',
      loadState: 'error',
      patch,
      ...(range ? { range } : {}),
      summary: createSummary(rangeRefs.contentError, { canLoad: true }),
    };
  }

  if (attemptedContent && !patchBinary) {
    const summary = summarizeContent(oldFile, newFile);
    const oldContents = oldFile.file?.contents ?? '';
    const newContents = newFile.file?.contents ?? '';
    // A modification that reads empty on both sides means the content failed to
    // load; keep the patch instead of rendering it as an empty (no-op) diff.
    const contentMissing =
      (file.status === 'modified' || file.status === 'renamed') &&
      oldContents === '' &&
      newContents === '';

    if (summary.loadState === 'ready' && !contentMissing) {
      return {
        binary: false,
        id,
        kind: 'pull-request',
        loadState: 'ready',
        newFile: newFile.file,
        oldFile: oldFile.file,
        patch,
        ...(range ? { range } : {}),
      };
    }

    if (summary.loadState !== 'ready') {
      return {
        ...summary,
        id,
        kind: 'pull-request',
        patch,
        ...(range ? { range } : {}),
      };
    }
  }

  const retryOmittedPatch = !patch && contentLoadable && !patchBinary && !contentAttempted;
  const loadState = patchUnavailable
    ? 'error'
    : patchBinary
      ? 'binary'
      : retryOmittedPatch
        ? 'deferred'
        : !patch && contentAttempted
          ? 'error'
          : 'ready';
  return {
    binary: patchBinary,
    id,
    kind: 'pull-request',
    loadState,
    patch,
    ...(range ? { range } : {}),
    summary: createSummary(
      patchUnavailable
        ? 'The provider did not return a patch or immutable content identity for this file.'
        : patchBinary
          ? 'Binary file changed.'
          : retryOmittedPatch
            ? 'Exact contents are not available yet; retry loading this provider-omitted patch.'
            : !patch && contentAttempted
              ? 'The provider omitted the patch and exact file contents could not be loaded.'
              : 'Showing the pull request patch for this file.',
      { canLoad: retryOmittedPatch },
    ),
  };
};

module.exports = {
  canHydrateArtifactFile,
  createPullRequestSection,
  isBinaryDiffPatch,
  rangeArtifactToPullRequestFiles,
};
