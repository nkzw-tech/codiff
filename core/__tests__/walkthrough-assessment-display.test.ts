import { expect, test } from 'vite-plus/test';
import {
  buildAssessmentDestinationIndex,
  getThreadAssessmentDisplay,
} from '../lib/walkthrough-assessment-display.ts';
import type { AssessmentComponent, WalkthroughModel } from '../types.ts';

const component = (threadState: 'open' | 'resolved'): AssessmentComponent => ({
  capturedPresentationState: { threadState },
  identity: { codeScope: { type: 'single-diff' }, threadId: 'thread-1' },
  input: {
    codeScope: { type: 'single-diff' },
    thread: {
      comments: [{ author: { login: 'reviewer' }, body: 'Check this.', id: 'comment-1' }],
      id: 'thread-1',
    },
  },
  outcome: { error: 'Unavailable.', status: 'failed' },
});

test('captured open stays initially visible when the live thread is resolved', () => {
  const captured = component('open');
  expect(
    getThreadAssessmentDisplay(captured, {
      currentThreadStateById: new Map([['thread-1', 'resolved']]),
    }),
  ).toMatchObject({ capturedThreadState: 'open', currentStateLabel: 'Currently resolved' });
});

test('captured resolved stays initially filtered when the live thread is reopened', () => {
  const captured = component('resolved');
  expect(
    getThreadAssessmentDisplay(captured, {
      currentThreadStateById: new Map([['thread-1', 'open']]),
    }),
  ).toMatchObject({ capturedThreadState: 'resolved', currentStateLabel: 'Currently open' });
});

const walkthroughWithAssessment = (
  anchor: { filePath: string; lineNumber?: number; side?: 'additions' | 'deletions' },
  support = false,
): WalkthroughModel => {
  const assessment = {
    ...component('open'),
    input: {
      ...component('open').input,
      thread: {
        comments: [{ anchor, author: { login: 'reviewer' }, body: 'Check this.', id: 'comment-1' }],
        id: 'thread-1',
      },
    },
  } satisfies AssessmentComponent;
  const group = {
    added: 2,
    deleted: 0,
    hunkIds: ['h1'],
    hunks: [
      {
        added: 2,
        additionEnd: 12,
        additionStart: 11,
        anchor: {
          display: 'src/app.ts:11',
          endLine: 12,
          side: 'additions' as const,
          startLine: 11,
        },
        deleted: 0,
        id: 'h1',
        path: 'src/app.ts',
        status: 'modified' as const,
      },
    ],
    id: support ? 'support-1' : 'stop-1',
  };
  return {
    agent: 'codex',
    assessments: { items: [assessment] },
    chapters: support
      ? []
      : [
          {
            blurb: 'Main',
            icon: 'path',
            id: 'chapter-1',
            stops: [{ ...group, importance: 'normal', prose: 'Review it.' }],
            title: 'Main',
          },
        ],
    focus: 'Focus',
    generatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main' },
    source: { type: 'working-tree' },
    sourceVersion: 5,
    support: support ? [{ ...group, note: 'Support', reason: 'Mechanical' }] : [],
    title: 'Walkthrough',
  } as unknown as WalkthroughModel;
};

test('indexes generated assessments to their exact stop or Support destination', () => {
  expect(
    buildAssessmentDestinationIndex(
      walkthroughWithAssessment({ filePath: 'src/app.ts', lineNumber: 12, side: 'additions' }),
    ).get('thread-1'),
  ).toEqual({ kind: 'stop', stopId: 'stop-1', stopIndex: 0 });
  expect(
    buildAssessmentDestinationIndex(
      walkthroughWithAssessment(
        { filePath: 'src/app.ts', lineNumber: 11, side: 'additions' },
        true,
      ),
    ).get('thread-1'),
  ).toEqual({ kind: 'support', supportId: 'support-1' });
});

test('rejects a generated assessment without a walkthrough destination', () => {
  expect(() =>
    buildAssessmentDestinationIndex(
      walkthroughWithAssessment({ filePath: 'src/missing.ts', lineNumber: 4 }),
    ),
  ).toThrow(/does not map to a walkthrough stop or Support block/);
});
