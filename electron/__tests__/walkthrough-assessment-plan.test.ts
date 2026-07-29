import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import type {
  AssessmentComponent,
  GenerationProfile,
  PullRequestExistingReviewComment,
  WalkthroughArtifactV5,
} from '../../core/types.ts';
import {
  assessmentValuesEqual,
  createAssessmentDemandsFromSelections,
  normalizeAssessmentInput,
  reconcileWalkthroughAssessments,
  selectWalkthroughAssessmentCandidates,
} from '../../core/walkthrough-authoring.ts';

const require = createRequire(import.meta.url);
const { buildWalkthroughAssessmentPlan } =
  require('../walkthrough-assessment-plan.cjs') as typeof import('../walkthrough-assessment-plan.cjs');
const authoring = {
  assessmentValuesEqual,
  createAssessmentDemandsFromSelections,
  normalizeAssessmentInput,
  reconcileWalkthroughAssessments,
  selectWalkthroughAssessmentCandidates,
};
const profile = {
  agent: 'codex',
  authoringVersion: 'walkthrough-assessment-1',
  modelCandidates: ['gpt-5'],
  settings: {},
} satisfies GenerationProfile;
const comment = (
  body: string,
  resolved = false,
  threadId = 'thread-1',
): PullRequestExistingReviewComment => ({
  author: { login: 'reviewer' },
  body,
  filePath: 'src/app.ts',
  id: `${threadId}:comment`,
  isThreadResolved: resolved,
  lineNumber: 1,
  side: 'additions',
  threadId,
});
const component = (
  body: string,
  state: 'open' | 'resolved' = 'open',
  threadId = 'thread-1',
): AssessmentComponent => ({
  capturedPresentationState: { threadState: state },
  identity: { codeScope: { type: 'single-diff' }, threadId },
  input: normalizeAssessmentInput({
    codeScope: { type: 'single-diff' },
    comments: [comment(body, false, threadId)],
  }),
  outcome: {
    generationMetadata: {
      agent: 'codex',
      generatedAt: '2026-01-01T00:00:00.000Z',
      model: 'gpt-5',
      profile,
    },
    result: { disposition: 'still-applies', explanation: 'It still applies.' },
    status: 'ready',
  },
});
const artifact = (items: ReadonlyArray<AssessmentComponent>): WalkthroughArtifactV5 => ({
  assessments: { items },
  capturedContext: {
    branch: 'main',
    files: [
      {
        fingerprint: 'file',
        path: 'src/app.ts',
        sections: [
          {
            binary: false,
            id: 'section',
            kind: 'pull-request',
            patch: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
        status: 'modified',
      },
    ],
    source: { type: 'working-tree' },
  },
  generationRequest: { review: { relation: 'single-diff', structure: 'single-diff' } },
  narrative: {} as never,
  version: 5,
});
const plan = (stored: AssessmentComponent, nextComment: PullRequestExistingReviewComment) =>
  buildWalkthroughAssessmentPlan({
    artifact: artifact([stored]),
    authoring,
    comments: [nextComment],
    profile,
  });

test('a state-only refresh reuses the component without model work', () => {
  const stored = component('Check this.', 'open');
  const result = plan(stored, comment('Check this.', true));
  expect(result.tasks).toEqual([]);
  expect(result.artifact.assessments?.items).toEqual([stored]);
});

test('a content edit removes and regenerates only the affected assessment', () => {
  const stored = component('Check this.');
  const sibling = component('Sibling comment.', 'open', 'thread-2');
  const result = buildWalkthroughAssessmentPlan({
    artifact: artifact([stored, sibling]),
    authoring,
    comments: [comment('Updated comment.'), comment('Sibling comment.', false, 'thread-2')],
    profile,
  });
  expect(result.artifact.assessments?.items).toEqual([sibling]);
  expect(result.tasks).toHaveLength(1);
  expect(result.tasks[0]?.expectedComponent).toBe(null);
});

test('a failed assessment remains visible until its independent retry replaces it', () => {
  const failed = {
    ...component('Check this.'),
    outcome: { error: 'First attempt failed.', status: 'failed' as const },
  } satisfies AssessmentComponent;
  const result = plan(failed, comment('Check this.'));

  expect(result.artifact.assessments?.items).toEqual([failed]);
  expect(result.tasks[0]?.expectedComponent).toEqual(failed);
});
