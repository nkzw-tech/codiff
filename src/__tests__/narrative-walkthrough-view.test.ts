import { expect, test } from 'vite-plus/test';
import {
  buildCommitModel,
  buildOrderView,
  resolveOrder,
  resolveSegmentFile,
} from '../lib/narrative-walkthrough.ts';
import type { ChangedFile, NarrativeWalkthrough } from '../types.ts';

const walkthrough = (): NarrativeWalkthrough => ({
  agent: 'claude',
  defaultOrder: 'keys',
  focus: 'Focus.',
  generatedAt: '2026-06-05T00:00:00.000Z',
  kind: 'narrative',
  orders: [
    {
      id: 'keys',
      label: 'Key changes first',
      phases: [
        { blurb: 'The bug.', icon: 'bug', id: 'bug', n: 1, title: 'The bug' },
        { blurb: 'The proof.', icon: 'flask', id: 'proof', n: 2, title: 'Proof' },
      ],
      rest: [
        { note: 'Regenerated.', reason: 'Lockfile', segmentId: 'lock' },
        { note: 'Mirror.', reason: 'Mechanical', segmentId: 'mirror' },
      ],
      restBlurb: 'Skim only.',
      restLabel: 'Not in the arc',
      sequence: [
        { importance: 'critical', phaseId: 'bug', prose: 'Bug.', segmentId: 's1' },
        { importance: 'normal', phaseId: 'proof', prose: 'Test.', segmentId: 's2' },
      ],
      tagline: 'Cause leads.',
    },
    {
      id: 'results',
      label: 'Results first',
      phases: [{ blurb: 'Proof.', icon: 'flask', id: 'results', n: 1, title: 'Results' }],
      rest: [{ note: 'Regenerated.', reason: 'Lockfile', segmentId: 'lock' }],
      restBlurb: 'Just noise.',
      restLabel: 'Just mechanical',
      sequence: [
        { importance: 'normal', phaseId: 'results', prose: 'Test leads.', segmentId: 's2' },
      ],
      tagline: 'Outcomes lead.',
    },
  ],
  repo: { branch: 'main', root: '/repo' },
  segments: [
    {
      added: 1,
      anchor: { display: 'src/App.tsx:311', sectionId: 'src/App.tsx:staged', side: 'both' },
      deleted: 1,
      granularity: 'line',
      id: 's1',
      path: 'src/App.tsx',
      status: 'modified',
    },
    {
      added: 14,
      anchor: { display: 'test.ts (new)' },
      deleted: 0,
      granularity: 'file',
      id: 's2',
      path: 'src/test.ts',
      status: 'added',
    },
    {
      added: 312,
      anchor: { display: 'pnpm-lock.yaml' },
      deleted: 180,
      granularity: 'file',
      id: 'lock',
      path: 'pnpm-lock.yaml',
      status: 'modified',
    },
    {
      added: 5,
      anchor: { display: 'mirror.ts' },
      deleted: 0,
      granularity: 'file',
      id: 'mirror',
      path: 'mirror.ts',
      status: 'added',
    },
  ],
  source: { type: 'working-tree' },
  title: 'Title',
  version: 2,
});

test('resolveOrder honours id, then default, then first', () => {
  const wt = walkthrough();
  expect(resolveOrder(wt, 'results')?.id).toBe('results');
  expect(resolveOrder(wt, undefined)?.id).toBe('keys');
  expect(resolveOrder(wt, 'nope')?.id).toBe('keys');
});

test('buildOrderView indexes stops, fills phases, and resolves segments', () => {
  const view = buildOrderView(walkthrough(), 'keys')!;

  expect(view.sequence.map((stop) => stop.index)).toEqual([0, 1]);
  expect(view.sequence[0].segment.path).toBe('src/App.tsx');
  expect(view.phases.map((phase) => phase.stops.map((stop) => stop.segmentId))).toEqual([
    ['s1'],
    ['s2'],
  ]);
  expect(view.totals).toEqual({ added: 15, deleted: 1 });
});

test('buildOrderView groups the rest by reason and totals it', () => {
  const view = buildOrderView(walkthrough(), 'keys')!;

  expect(view.restByReason.map((group) => group.reason)).toEqual(['Lockfile', 'Mechanical']);
  expect(view.restByReason[0].files[0].segment.path).toBe('pnpm-lock.yaml');
  expect(view.restTotals).toEqual({ added: 317, deleted: 180 });
});

test('the same segment can lead one order and rest in another', () => {
  const wt = walkthrough();
  const keys = buildOrderView(wt, 'keys')!;
  const results = buildOrderView(wt, 'results')!;

  // s2 is a proof stop under keys, and a lead stop under results.
  expect(keys.sequence.some((stop) => stop.segmentId === 's2')).toBe(true);
  expect(results.sequence[0].segmentId).toBe('s2');
  // 'mirror' rests under keys but isn't referenced by results at all.
  expect(keys.rest.some((item) => item.segmentId === 'mirror')).toBe(true);
  expect(results.rest.map((item) => item.segmentId)).toEqual(['lock']);
});

test('buildCommitModel collapses the order into phase groups plus the rest', () => {
  const view = buildOrderView(walkthrough(), 'keys')!;
  const model = buildCommitModel(view);

  expect(model.groups.map((group) => [group.title, group.isRest])).toEqual([
    ['The bug', false],
    ['Proof', false],
    ['Not in the arc', true],
  ]);
  expect(model.groups[2].files.map((file) => file.path)).toEqual(['pnpm-lock.yaml', 'mirror.ts']);
  expect(model.files.map((file) => file.path)).toEqual([
    'src/App.tsx',
    'src/test.ts',
    'pnpm-lock.yaml',
    'mirror.ts',
  ]);
});

test('buildCommitModel carries per-file change-type tags and notes onto the rows', () => {
  const base = walkthrough();
  const tagged: Record<string, Partial<NarrativeWalkthrough['segments'][number]>> = {
    lock: { changeType: 'lockfile' },
    s1: { changeType: 'fix', commitNote: 'reorder the hunks' },
    s2: { changeType: 'test', commitNote: 'lock the regression' },
  };
  const wt: NarrativeWalkthrough = {
    ...base,
    segments: base.segments.map((segment) => ({ ...segment, ...tagged[segment.id] })),
  };
  const model = buildCommitModel(buildOrderView(wt, 'keys')!);
  const byPath = new Map(model.files.map((file) => [file.path, file]));

  expect(byPath.get('src/App.tsx')).toMatchObject({ changeType: 'fix', note: 'reorder the hunks' });
  expect(byPath.get('src/test.ts')).toMatchObject({
    changeType: 'test',
    note: 'lock the regression',
  });
  expect(byPath.get('pnpm-lock.yaml')?.changeType).toBe('lockfile');
});

test('resolveSegmentFile prefers the anchor section then the first visible one', () => {
  const files: ReadonlyArray<ChangedFile> = [
    {
      fingerprint: 'a',
      path: 'src/App.tsx',
      sections: [
        {
          binary: false,
          id: 'src/App.tsx:unstaged',
          kind: 'unstaged',
          patch: '@@ -1 +1 @@\n-a\n+b\n',
        },
        { binary: false, id: 'src/App.tsx:staged', kind: 'staged', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      ],
      status: 'modified',
    },
  ];
  const wt = walkthrough();
  const segment = wt.segments.find((s) => s.id === 's1')!;

  const resolved = resolveSegmentFile(segment, files, false);
  expect(resolved?.section.id).toBe('src/App.tsx:staged');

  // A segment whose path isn't in the diff resolves to null.
  const missing = wt.segments.find((s) => s.id === 's2')!;
  expect(resolveSegmentFile(missing, files, false)).toBeNull();
});
