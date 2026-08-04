import { join } from 'node:path';
import {
  currentCommitStackPatches,
  materializeCurrentCommitStack,
} from './current/current-commit-stack/materialize.mjs';
import {
  materializeUnstructuredBucket,
  unstructuredCommitPatches,
} from './current/unstructured-commits/materialize.mjs';

const scenarioRoot = join('test-scenarios', 'review');

const scenario = ({ description, id, kind, materialize, patchSequence, walkthroughExpectations }) =>
  Object.freeze({
    description,
    id,
    kind,
    materialize,
    patchSequence,
    root: join(scenarioRoot, kind, id),
    walkthroughExpectations,
  });

export const reviewScenarios = Object.freeze({
  'current-commit-stack': scenario({
    description: 'An intentional layered stack presented as one current review.',
    id: 'current-commit-stack',
    kind: 'current',
    materialize: materializeCurrentCommitStack,
    patchSequence: currentCommitStackPatches.map(({ patch }) => patch),
    walkthroughExpectations: {
      artifactVersion: 4,
      callTopology: { whole: 'positive' },
      comparisonScope: 'current-review',
      minimumChapters: 4,
      minimumStops: 7,
      reviewStructure: 'single-diff',
    },
  }),
  'unstructured-commits': scenario({
    description: 'A mixed set of changes presented as one current review.',
    id: 'unstructured-commits',
    kind: 'current',
    materialize: materializeUnstructuredBucket,
    patchSequence: unstructuredCommitPatches.map(({ patch }) => patch),
    walkthroughExpectations: {
      artifactVersion: 4,
      callTopology: { whole: 'positive' },
      comparisonScope: 'current-review',
      minimumChapters: 3,
      minimumStops: 6,
      reviewStructure: 'single-diff',
    },
  }),
});

/**
 * @param {{
 *   baseBranch?: string,
 *   featureBranch?: string,
 *   onCheckpoint?: (checkpoint: {kind: string}) => Promise<void> | void,
 *   root: string,
 *   runGit: (args: ReadonlyArray<string>) => Promise<string> | string,
 *   scenarioId: string,
 * }} options
 */
export const materializeReviewScenario = async ({
  baseBranch = 'main',
  featureBranch = 'feature/test-scenario',
  onCheckpoint = undefined,
  root,
  runGit,
  scenarioId,
}) => {
  const definition = reviewScenarios[scenarioId];
  if (!definition) {
    throw new Error(`Unknown review scenario: ${scenarioId}`);
  }
  return definition.materialize({
    baseBranch,
    featureBranch,
    onCheckpoint,
    root,
    runGit,
  });
};
