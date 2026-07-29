import { expect, test } from 'vite-plus/test';
import {
  reconcileWalkthroughAssessments,
  type AssessmentDemand,
} from '../lib/walkthrough-assessment-cache.ts';
import { createAssessmentGenerationProfile } from '../lib/walkthrough-assessments.ts';
import type { AssessmentComponent } from '../types.ts';

const scope = { type: 'single-diff' as const };
const profile = createAssessmentGenerationProfile({
  agent: 'codex',
  modelCandidates: ['primary', 'fallback'],
});
const demand = (
  threadId: string,
  body: string,
  threadState: 'open' | 'resolved',
): AssessmentDemand => ({
  capturedPresentationState: { threadState },
  identity: { codeScope: scope, threadId },
  input: {
    codeScope: scope,
    thread: {
      comments: [{ author: { login: 'reviewer' }, body, id: `${threadId}:comment` }],
      id: threadId,
    },
  },
});
const component = (input: AssessmentDemand): AssessmentComponent => ({
  ...input,
  outcome: {
    generationMetadata: {
      agent: 'codex',
      generatedAt: '2026-07-28T00:00:00.000Z',
      model: 'fallback',
      profile,
    },
    result: { disposition: 'still-applies', explanation: 'The affected branch remains unchanged.' },
    status: 'ready',
  },
});

test('reuses by assessment input and profile while ignoring presentation-only state', () => {
  const storedDemand = demand('thread-1', 'Please preserve the fallback.', 'open');
  const currentDemand = demand('thread-1', 'Please preserve the fallback.', 'resolved');
  const stored = component(storedDemand);

  const result = reconcileWalkthroughAssessments({
    components: [stored],
    demands: [currentDemand],
    profile,
  });

  expect(result.generate).toEqual([]);
  expect(result.reuse).toEqual([stored]);
  expect(result.reuse[0]?.capturedPresentationState.threadState).toBe('open');
});

test('regenerates only the assessment whose thread content changed', () => {
  const first = demand('thread-1', 'First body.', 'open');
  const second = demand('thread-2', 'Second body.', 'open');
  const changedFirst = demand('thread-1', 'Edited first body.', 'open');

  const result = reconcileWalkthroughAssessments({
    components: [component(first), component(second)],
    demands: [changedFirst, second],
    profile,
  });

  expect(result.generate).toEqual([changedFirst]);
  expect(result.reuse.map((entry) => entry.identity.threadId)).toEqual(['thread-2']);
  expect(result.remove).toEqual([]);
});

test('regenerates failed or profile-mismatched components and removes obsolete identities', () => {
  const first = demand('thread-1', 'First body.', 'open');
  const obsolete = demand('thread-old', 'Old body.', 'open');
  const failed: AssessmentComponent = {
    ...first,
    outcome: { error: 'temporary failure', status: 'failed' },
  };
  const result = reconcileWalkthroughAssessments({
    components: [failed, component(obsolete)],
    demands: [first],
    profile: { ...profile, modelCandidates: ['new-model'] },
  });

  expect(result.generate).toEqual([first]);
  expect(result.reuse).toEqual([]);
  expect(result.remove.map((entry) => entry.identity.threadId)).toEqual(['thread-old']);
});

test('rejects duplicate demanded identities', () => {
  const first = demand('thread-1', 'First body.', 'open');
  expect(() =>
    reconcileWalkthroughAssessments({
      components: [],
      demands: [first, { ...first, input: { ...first.input } }],
      profile,
    }),
  ).toThrow('identities must be unique');
});
