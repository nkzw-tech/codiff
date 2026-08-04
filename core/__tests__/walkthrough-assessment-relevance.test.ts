import { expect, test } from 'vite-plus/test';
import {
  eligibleWalkthroughAssessmentCandidates,
  selectWalkthroughAssessmentCandidates,
  type AssessmentRoutingContext,
  type AssessmentThreadCandidate,
} from '../lib/walkthrough-assessment-relevance.ts';
import type { GitSha } from '../types.ts';

const gitSha = (value: string) => value as GitSha;

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

test('routes a thread to the only commit that owns its changed range', () => {
  const selections = selectWalkthroughAssessmentCandidates([candidate('thread-1')], {
    ...context(),
    codeScope: {
      range: {
        base: { label: { kind: 'commit', text: 'base' }, sha: gitSha('a'.repeat(40)) },
        head: { label: { kind: 'commit', text: 'head' }, sha: gitSha('b'.repeat(40)) },
      },
      type: 'target-comparison',
    },
    unitRoutes: [
      {
        changedRanges: [{ endLine: 20, path: 'src/router.ts', side: 'additions', startLine: 5 }],
        codeScope: { sha: gitSha('1'.repeat(40)), type: 'commit' },
      },
      {
        changedRanges: [{ endLine: 20, path: 'src/other.ts', side: 'additions', startLine: 5 }],
        codeScope: { sha: gitSha('2'.repeat(40)), type: 'commit' },
      },
    ],
  });

  expect(selections[0]).toMatchObject({
    codeScope: { sha: '1'.repeat(40), type: 'commit' },
    kind: 'eligible',
  });
});

test('falls back to aggregate scope when multiple commits own a changed range', () => {
  const codeScope = {
    range: {
      base: { label: { kind: 'commit' as const, text: 'base' }, sha: gitSha('a'.repeat(40)) },
      head: { label: { kind: 'commit' as const, text: 'head' }, sha: gitSha('b'.repeat(40)) },
    },
    type: 'target-comparison' as const,
  };
  const changedRanges = [
    { endLine: 20, path: 'src/router.ts', side: 'additions' as const, startLine: 5 },
  ];
  const selections = selectWalkthroughAssessmentCandidates([candidate('thread-1')], {
    ...context(),
    codeScope,
    unitRoutes: [
      { changedRanges, codeScope: { sha: gitSha('1'.repeat(40)), type: 'commit' } },
      { changedRanges, codeScope: { sha: gitSha('2'.repeat(40)), type: 'commit' } },
    ],
  });

  expect(selections[0]).toMatchObject({ codeScope, kind: 'eligible' });
});
