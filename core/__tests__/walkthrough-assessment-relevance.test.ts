import { expect, test } from 'vite-plus/test';
import {
  eligibleWalkthroughAssessmentCandidates,
  selectWalkthroughAssessmentCandidates,
  type AssessmentRoutingContext,
  type AssessmentThreadCandidate,
} from '../lib/walkthrough-assessment-relevance.ts';

const candidate = (threadId: string): AssessmentThreadCandidate => ({
  anchor: {
    endLine: 12,
    kind: 'line',
    path: 'src/router.ts',
    side: 'additions',
    startLine: 10,
  },
  thread: {
    comments: [{ author: { login: 'reviewer' }, body: 'Check this branch.', id: `${threadId}:1` }],
    id: threadId,
  },
});
const context = (): AssessmentRoutingContext => ({
  changedRanges: [{ endLine: 20, path: 'src/router.ts', side: 'additions', startLine: 5 }],
  codeScope: { type: 'single-diff' },
});

test('routes applicable threads to the captured single diff', () => {
  const selections = selectWalkthroughAssessmentCandidates([candidate('thread-1')], context());
  expect(eligibleWalkthroughAssessmentCandidates(selections)).toEqual([
    expect.objectContaining({ codeScope: { type: 'single-diff' }, kind: 'eligible' }),
  ]);
});

test('routes file comments and automated-reviewer threads normally', () => {
  const fileComment: AssessmentThreadCandidate = {
    anchor: { kind: 'file', path: 'src/router.ts' },
    thread: {
      comments: [{ author: { login: 'code-review-bot' }, body: 'Check this file.', id: 'bot:1' }],
      id: 'bot',
    },
  };

  expect(selectWalkthroughAssessmentCandidates([fileComment], context())[0]).toMatchObject({
    codeScope: { type: 'single-diff' },
    kind: 'eligible',
  });
});

test('keeps unanchored and non-overlapping threads out of assessment demand', () => {
  const selections = selectWalkthroughAssessmentCandidates(
    [
      {
        ...candidate('outside'),
        anchor: { ...candidate('outside').anchor!, path: 'src/other.ts' },
      },
      { ...candidate('missing'), anchor: undefined },
      {
        ...candidate('incomplete'),
        anchor: { ...candidate('incomplete').anchor!, endLine: undefined },
      },
    ],
    context(),
  );

  expect(
    selections.map((selection) => ('reason' in selection ? selection.reason : 'eligible')),
  ).toEqual(['no-code-scope', 'missing-anchor', 'missing-anchor']);
});
