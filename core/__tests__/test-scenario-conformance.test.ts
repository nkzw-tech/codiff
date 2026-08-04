import { expect, test } from 'vite-plus/test';
import { evaluateScenarioConformance } from '../../test-scenarios/conformance.mjs';
import type { NarrativeWalkthrough, WalkthroughChapter, WalkthroughStop } from '../types.ts';

const stop = (id: string, prose: string): WalkthroughStop => ({
  added: 1,
  deleted: 0,
  hunkIds: [],
  hunks: [],
  id,
  importance: 'normal',
  prose,
  title: id,
});

const chapters: ReadonlyArray<WalkthroughChapter> = [
  {
    blurb: 'Quiet-hour policy explains delivery orchestration.',
    icon: 'path',
    id: 'policy',
    stops: [
      stop('audit', 'The audit trail records preference updates.'),
      stop('delivery', 'Delivery scheduling applies the quiet-hour policy.'),
    ],
    title: 'Policy',
  },
  {
    blurb: 'Lifecycle verification covers the persisted audit trail.',
    icon: 'flask',
    id: 'verification',
    stops: [stop('verification-stop', 'Verification asserts the preference update revision.')],
    title: 'Verification',
  },
];

const walkthrough: NarrativeWalkthrough = {
  agent: 'codex',
  chapters,
  focus: 'Review the current notification-preferences change.',
  generatedAt: '2026-07-29T00:00:00.000Z',
  kind: 'narrative',
  repo: { branch: 'feature', root: '/repo' },
  source: { type: 'working-tree' },
  support: [],
  title: 'Notification preferences',
  version: 4,
};

const expectation = {
  artifactVersion: 4,
  callTopology: { whole: 'positive' },
  comparisonScope: 'current-review',
  minimumChapters: 2,
  minimumStops: 3,
  reviewStructure: 'single-diff',
};

test('scenario conformance gates structural breadth and topology independently of quality', () => {
  expect(
    evaluateScenarioConformance({
      callTopology: { whole: 1 },
      expectation,
      reviewScope: {
        comparisonScope: 'current-review',
        reviewStructure: 'single-diff',
      },
      walkthrough,
    }),
  ).toMatchObject({ failures: [], pass: true });
});

test('scenario conformance accepts a format-neutral narrative projection', () => {
  expect(
    evaluateScenarioConformance({
      callTopology: { whole: 1 },
      expectation,
      narrative: { chapters, focus: walkthrough.focus },
      reviewScope: {
        comparisonScope: 'current-review',
        reviewStructure: 'single-diff',
      },
      walkthrough: { version: 4 },
    }),
  ).toMatchObject({ chapterCount: 2, failures: [], pass: true, stopCount: 3 });
});

test('scenario conformance leaves semantic coverage to the evaluation judge', () => {
  const result = evaluateScenarioConformance({
    callTopology: { whole: 1 },
    expectation: {
      ...expectation,
      minimumChapters: 1,
      minimumStops: 1,
    },
    narrative: {
      chapters: [
        {
          blurb: 'The prose deliberately discusses unrelated implementation details.',
          icon: 'path',
          id: 'unrelated',
          stops: [stop('unrelated-stop', 'No deterministic concept matcher runs here.')],
          title: 'Unrelated details',
        },
      ],
      focus: 'Review structural conformance only.',
    },
    reviewScope: {
      comparisonScope: 'current-review',
      reviewStructure: 'single-diff',
    },
    walkthrough: { version: 4 },
  });

  expect(result).toMatchObject({ failures: [], pass: true });
});

test('scenario conformance rejects invalid scope and call topology', () => {
  const result = evaluateScenarioConformance({
    callTopology: { whole: 0 },
    expectation,
    reviewScope: {
      comparisonScope: 'current-review',
      reviewStructure: 'unexpected',
    },
    walkthrough,
  });

  expect(result.pass).toBe(false);
  expect(result.failures).toContain('Expected single-diff review structure, received unexpected.');
  expect(result.failures).toContain('Expected whole model calls to be positive, received 0.');
});
