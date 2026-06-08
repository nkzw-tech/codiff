import { expect, test } from 'vite-plus/test';
import { getWalkthroughNavigationKeyDirection } from '../app/components/walkthrough/NarrativeWalkthroughView.tsx';
import { parseSectionDiffWithOptions } from '../lib/diff.ts';
import {
  buildCommitModel,
  buildGenericCommitModel,
  buildWalkthroughView,
  focusChangedFileForHunks,
  formatWalkthroughFileLineRows,
  formatWalkthroughFileList,
  getCommitSelectionPaths,
  getUncoveredWalkthroughFileLineItems,
  getUncoveredWalkthroughFiles,
  getWalkthroughRunNote,
  isWalkthroughCommittable,
  resolveWalkthroughHunkFile,
  resolveWalkthroughHunkRuns,
  walkthroughItemPaths,
} from '../lib/narrative-walkthrough.ts';
import type {
  ChangedFile,
  NarrativeWalkthrough,
  WalkthroughHunk,
  WalkthroughHunkGroup,
} from '../types.ts';

const hunk = ({
  added,
  additionEnd,
  additionStart,
  deleted,
  deletionEnd,
  deletionStart,
  display,
  id,
  kind,
  path,
  sectionId,
  status,
}: {
  added: number;
  additionEnd?: number;
  additionStart?: number;
  deleted: number;
  deletionEnd?: number;
  deletionStart?: number;
  display: string;
  id: string;
  kind?: WalkthroughHunk['kind'];
  path: string;
  sectionId: string;
  status: WalkthroughHunk['status'];
}): WalkthroughHunk => ({
  added,
  additionEnd,
  additionStart,
  anchor: { display, sectionId, side: 'both' },
  deleted,
  deletionEnd,
  deletionStart,
  id,
  ...(kind ? { kind } : {}),
  path,
  status,
});

const appHunk = hunk({
  added: 1,
  deleted: 1,
  display: 'src/App.tsx:311',
  id: 'src/App.tsx:staged:h1',
  path: 'src/App.tsx',
  sectionId: 'src/App.tsx:staged',
  status: 'modified',
});

const testHunk = hunk({
  added: 14,
  deleted: 0,
  display: 'test.ts (new)',
  id: 'src/test.ts:staged:h1',
  path: 'src/test.ts',
  sectionId: 'src/test.ts:staged',
  status: 'added',
});

const lockHunk = hunk({
  added: 312,
  deleted: 180,
  display: 'pnpm-lock.yaml',
  id: 'pnpm-lock.yaml:staged:h1',
  path: 'pnpm-lock.yaml',
  sectionId: 'pnpm-lock.yaml:staged',
  status: 'modified',
});

const mirrorHunk = hunk({
  added: 5,
  deleted: 0,
  display: 'mirror.ts',
  id: 'mirror.ts:staged:h1',
  path: 'mirror.ts',
  sectionId: 'mirror.ts:staged',
  status: 'added',
});

const keyEvent = (
  key: string,
  modifiers: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  altKey: modifiers.altKey ?? false,
  ctrlKey: modifiers.ctrlKey ?? false,
  key,
  metaKey: modifiers.metaKey ?? false,
  shiftKey: modifiers.shiftKey ?? false,
});

const group = ({
  hunks,
  id,
  title,
}: {
  hunks: ReadonlyArray<WalkthroughHunk>;
  id: string;
  title?: string;
}): WalkthroughHunkGroup => ({
  added: hunks.reduce((total, hunk) => total + hunk.added, 0),
  deleted: hunks.reduce((total, hunk) => total + hunk.deleted, 0),
  hunkIds: hunks.map((hunk) => hunk.id),
  hunks,
  id,
  title,
});

const walkthrough = (): NarrativeWalkthrough => ({
  agent: 'claude',
  chapters: [
    {
      blurb: 'The bug.',
      icon: 'bug',
      id: 'bug',
      stops: [
        {
          ...group({ hunks: [appHunk], id: 's1' }),
          importance: 'critical',
          prose: 'Bug.',
        },
      ],
      title: 'The bug',
    },
    {
      blurb: 'The proof.',
      icon: 'flask',
      id: 'proof',
      stops: [
        {
          ...group({ hunks: [testHunk], id: 's2' }),
          importance: 'normal',
          prose: 'Test.',
        },
      ],
      title: 'Proof',
    },
  ],
  focus: 'Focus.',
  generatedAt: '2026-06-05T00:00:00.000Z',
  kind: 'narrative',
  repo: { branch: 'main', root: '/repo' },
  source: { type: 'working-tree' },
  support: [
    { ...group({ hunks: [lockHunk], id: 'lock' }), note: 'Regenerated.', reason: 'Lockfile' },
    { ...group({ hunks: [mirrorHunk], id: 'mirror' }), note: 'Mirror.', reason: 'Mechanical' },
  ],
  title: 'Title',
  version: 4,
});

test('formatWalkthroughFileList shows filenames up to five unique files', () => {
  expect(
    formatWalkthroughFileList(['src/App.tsx', 'src/App.tsx', 'tests/App.test.tsx', 'README.md']),
  ).toEqual({
    label: 'App.tsx, App.test.tsx, README.md',
    title: 'src/App.tsx\ntests/App.test.tsx\nREADME.md',
  });

  expect(formatWalkthroughFileList(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']).label).toBe(
    '6 files',
  );
});

test('walkthrough keyboard navigation ignores editor shortcut chords', () => {
  expect(getWalkthroughNavigationKeyDirection(keyEvent('j'))).toBe(1);
  expect(getWalkthroughNavigationKeyDirection(keyEvent('k'))).toBe(-1);
  expect(getWalkthroughNavigationKeyDirection(keyEvent('ArrowDown', { ctrlKey: true }))).toBe(1);
  expect(getWalkthroughNavigationKeyDirection(keyEvent('ArrowUp', { ctrlKey: true }))).toBe(-1);
  expect(getWalkthroughNavigationKeyDirection(keyEvent('k', { metaKey: true }))).toBe(0);
  expect(getWalkthroughNavigationKeyDirection(keyEvent('k', { ctrlKey: true }))).toBe(0);
  expect(getWalkthroughNavigationKeyDirection(keyEvent('j', { shiftKey: true }))).toBe(0);
});

test('formatWalkthroughFileLineRows gives each visible file its own count', () => {
  expect(formatWalkthroughFileLineRows([])).toEqual([
    { added: 0, deleted: 0, label: '0 files', title: '' },
  ]);

  expect(
    formatWalkthroughFileLineRows([
      { added: 1, deleted: 0, path: 'src/App.tsx' },
      { added: 2, deleted: 1, path: 'src/App.tsx' },
      { added: 3, deleted: 0, path: 'tests/App.test.tsx' },
    ]),
  ).toEqual([
    {
      added: 3,
      deleted: 1,
      label: 'App.tsx',
      path: 'src/App.tsx',
      title: 'src/App.tsx',
    },
    {
      added: 3,
      deleted: 0,
      label: 'App.test.tsx',
      path: 'tests/App.test.tsx',
      title: 'tests/App.test.tsx',
    },
  ]);
});

test('buildWalkthroughView indexes stops and groups support by reason', () => {
  const view = buildWalkthroughView(walkthrough())!;

  expect(view.sequence.map((stop) => [stop.id, stop.index, stop.chapterId])).toEqual([
    ['s1', 0, 'bug'],
    ['s2', 1, 'proof'],
  ]);
  expect(walkthroughItemPaths(view.sequence[0])).toEqual(['src/App.tsx']);
  expect(view.chapters.map((chapter) => chapter.stops.map((stop) => stop.id))).toEqual([
    ['s1'],
    ['s2'],
  ]);
  expect(view.supportByReason.map((support) => support.reason)).toEqual(['Lockfile', 'Mechanical']);
});

test('buildWalkthroughView preserves cross-file hunk groups in one stop', () => {
  const base = walkthrough();
  const wt: NarrativeWalkthrough = {
    ...base,
    chapters: [
      {
        ...base.chapters[0],
        stops: [
          {
            ...group({ hunks: [appHunk, testHunk], id: 'combo' }),
            importance: 'critical',
            prose: 'Bug and proof belong together.',
          },
        ],
      },
    ],
  };

  const view = buildWalkthroughView(wt)!;

  expect(view.sequence).toHaveLength(1);
  expect(view.sequence[0].id).toBe('combo');
  expect(walkthroughItemPaths(view.sequence[0])).toEqual(['src/App.tsx', 'src/test.ts']);
  expect(view.chapters[0].stops.map((stop) => stop.id)).toEqual(['combo']);
});

test('buildCommitModel collapses chapters plus support into unique file groups', () => {
  const model = buildCommitModel(buildWalkthroughView(walkthrough())!);

  expect(model.groups.map((group) => [group.title, group.isSupport])).toEqual([
    ['The bug', false],
    ['Proof', false],
    ['Support', true],
  ]);
  expect(model.groups[2].files.map((file) => file.path)).toEqual(['pnpm-lock.yaml', 'mirror.ts']);
  expect(model.files.map((file) => file.path)).toEqual([
    'src/App.tsx',
    'src/test.ts',
    'pnpm-lock.yaml',
    'mirror.ts',
  ]);
});

test('buildCommitModel carries per-file change-type tags and notes onto rows', () => {
  const base = walkthrough();
  const wt: NarrativeWalkthrough = {
    ...base,
    chapters: [
      {
        ...base.chapters[0],
        stops: [
          {
            ...base.chapters[0].stops[0],
            changeType: 'fix',
            commitNote: 'reorder the hunks',
          },
        ],
      },
      {
        ...base.chapters[1],
        stops: [
          {
            ...base.chapters[1].stops[0],
            changeType: 'test',
            commitNote: 'lock the regression',
          },
        ],
      },
    ],
    support: [{ ...base.support[0], changeType: 'lockfile' }, base.support[1]],
  };
  const model = buildCommitModel(buildWalkthroughView(wt)!);
  const byPath = new Map(model.files.map((file) => [file.path, file]));

  expect(byPath.get('src/App.tsx')).toMatchObject({ changeType: 'fix', note: 'reorder the hunks' });
  expect(byPath.get('src/test.ts')).toMatchObject({
    changeType: 'test',
    note: 'lock the regression',
  });
  expect(byPath.get('pnpm-lock.yaml')?.changeType).toBe('lockfile');
});

test('buildCommitModel appends live tree files missing from the walkthrough', () => {
  const files: ReadonlyArray<ChangedFile> = [
    {
      fingerprint: 'a',
      path: 'src/App.tsx',
      sections: [
        {
          binary: false,
          id: 'src/App.tsx:staged',
          kind: 'staged',
          patch: '@@ -1 +1 @@\n-a\n+b\n',
        },
      ],
      status: 'modified',
    },
    {
      fingerprint: 'missing',
      path: 'src/missed.ts',
      sections: [
        {
          binary: false,
          id: 'src/missed.ts:staged',
          kind: 'staged',
          patch: '@@ -1,0 +1,2 @@\n+one\n+two\n',
        },
      ],
      status: 'added',
    },
  ];

  const model = buildCommitModel(buildWalkthroughView(walkthrough())!, files);
  const missing = model.files.find((file) => file.path === 'src/missed.ts');

  expect(missing).toMatchObject({
    added: 2,
    deleted: 0,
    note: 'Not included in the generated walkthrough.',
  });
  expect(model.groups.at(-1)).toMatchObject({
    id: '__missing',
    title: 'Other changes',
  });
});

test('getCommitSelectionPaths follows commit model ordering and fallback files', () => {
  const files: ReadonlyArray<ChangedFile> = [
    {
      fingerprint: 'a',
      path: 'src/App.tsx',
      sections: [],
      status: 'modified',
    },
    {
      fingerprint: 'missing',
      path: 'src/missed.ts',
      sections: [],
      status: 'added',
    },
  ];
  const view = buildWalkthroughView(walkthrough())!;

  expect(getCommitSelectionPaths(view, files)).toEqual([
    'src/App.tsx',
    'src/test.ts',
    'pnpm-lock.yaml',
    'mirror.ts',
    'src/missed.ts',
  ]);
  expect(getCommitSelectionPaths(null, files)).toEqual(['src/App.tsx', 'src/missed.ts']);
});

test('uncovered walkthrough files keep visible non-hunk sections in support fallback', () => {
  const view = buildWalkthroughView(walkthrough())!;
  const files: ReadonlyArray<ChangedFile> = [
    {
      fingerprint: 'covered',
      path: 'src/App.tsx',
      sections: [
        {
          binary: false,
          id: 'src/App.tsx:staged',
          kind: 'staged',
          patch: '@@ -1 +1 @@\n-a\n+b\n',
        },
      ],
      status: 'modified',
    },
    {
      fingerprint: 'binary',
      path: 'public/logo.png',
      sections: [
        {
          binary: true,
          id: 'public/logo.png:staged',
          kind: 'staged',
          patch: '',
          summary: { reason: 'Binary file changed.' },
        },
      ],
      status: 'modified',
    },
  ];

  const uncoveredFiles = getUncoveredWalkthroughFiles(files, view, false);

  expect(uncoveredFiles.map((file) => file.path)).toEqual(['public/logo.png']);
  expect(uncoveredFiles[0].sections.map((section) => section.id)).toEqual([
    'public/logo.png:staged',
  ]);
  expect(getUncoveredWalkthroughFileLineItems(files, view, false)).toEqual([
    { added: 0, deleted: 0, path: 'public/logo.png' },
  ]);
});

test('covered synthetic hunks do not reappear in support fallback', () => {
  const file: ChangedFile = {
    fingerprint: 'binary',
    path: 'public/logo.png',
    sections: [
      {
        binary: true,
        id: 'public/logo.png:staged',
        kind: 'staged',
        loadState: 'binary',
        patch: '',
        summary: { reason: 'Binary file changed.' },
      },
    ],
    status: 'modified',
  };
  const synthetic = hunk({
    added: 0,
    deleted: 0,
    display: 'public/logo.png',
    id: 'public/logo.png:staged:h1',
    kind: 'synthetic',
    path: 'public/logo.png',
    sectionId: 'public/logo.png:staged',
    status: 'modified',
  });
  const view = buildWalkthroughView({
    ...walkthrough(),
    chapters: [
      {
        blurb: 'Assets',
        icon: 'path',
        id: 'assets',
        stops: [
          {
            ...group({ hunks: [synthetic], id: 'logo' }),
            importance: 'normal',
            prose: 'Review the image asset.',
          },
        ],
        title: 'Assets',
      },
    ],
    support: [],
  })!;

  expect(getUncoveredWalkthroughFiles([file], view, false)).toEqual([]);
});

test('covered synthetic sections do not reappear after content loads', () => {
  const file = multiHunkFile();
  const section = file.sections[0];
  const synthetic = hunk({
    added: 0,
    deleted: 0,
    display: file.path,
    id: `${section.id}:h1`,
    kind: 'synthetic',
    path: file.path,
    sectionId: section.id,
    status: 'modified',
  });
  const view = buildWalkthroughView({
    ...walkthrough(),
    chapters: [
      {
        blurb: 'Loaded',
        icon: 'path',
        id: 'loaded',
        stops: [
          {
            ...group({ hunks: [synthetic], id: 'loaded-section' }),
            importance: 'normal',
            prose: 'Review the loaded section.',
          },
        ],
        title: 'Loaded',
      },
    ],
    support: [],
  })!;

  expect(parseSectionDiffWithOptions(file, section, false).hunks.length).toBeGreaterThan(1);
  expect(getUncoveredWalkthroughFiles([file], view, false)).toEqual([]);
});

test('buildGenericCommitModel creates a commit group from live tree files', () => {
  const model = buildGenericCommitModel([
    {
      fingerprint: 'plain',
      path: 'src/plain.ts',
      sections: [
        {
          binary: false,
          id: 'src/plain.ts:unstaged',
          kind: 'unstaged',
          patch: [
            'diff --git a/src/plain.ts b/src/plain.ts',
            '--- a/src/plain.ts',
            '+++ b/src/plain.ts',
            '@@ -1 +1,2 @@',
            '-old',
            '+new',
            '+more',
          ].join('\n'),
        },
      ],
      status: 'modified',
    },
  ]);

  expect(model.groups).toHaveLength(1);
  expect(model.groups[0]).toMatchObject({
    id: '__changed',
    title: 'Changed files',
  });
  expect(model.files[0]).toMatchObject({
    added: 2,
    deleted: 1,
    path: 'src/plain.ts',
  });
});

test('working-tree walkthroughs are committable even without commit seed text', () => {
  const wt: NarrativeWalkthrough = {
    ...walkthrough(),
    commit: undefined,
    source: { type: 'working-tree' },
  };
  const committedReview: NarrativeWalkthrough = {
    ...walkthrough(),
    commit: {},
    source: { ref: 'HEAD', type: 'commit' },
  };

  expect(isWalkthroughCommittable(wt)).toBe(true);
  expect(isWalkthroughCommittable(committedReview)).toBe(false);
});

test('resolveWalkthroughHunkFile requires exact anchor section', () => {
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

  const resolved = resolveWalkthroughHunkFile(appHunk, files);
  expect(resolved?.section.id).toBe('src/App.tsx:staged');

  expect(
    resolveWalkthroughHunkFile(
      { ...appHunk, anchor: { ...appHunk.anchor, sectionId: 'src/App.tsx:missing' } },
      files,
    ),
  ).toBeNull();
  expect(resolveWalkthroughHunkFile(testHunk, files)).toBeNull();
});

const multiHunkFile = (): ChangedFile => ({
  fingerprint: 'database-search',
  path: 'database_search.py',
  sections: [
    {
      binary: false,
      id: 'database_search.py:unstaged',
      kind: 'unstaged',
      loadState: 'ready',
      newFile: {
        cacheKey: 'new',
        contents: [
          'line 1',
          'favorite.drag()',
          'line 3',
          'line 4',
          'line 5',
          'line 6',
          'line 7',
          'favorite.count()',
          'line 9',
          'line 10',
          'line 11',
          'database.commit_order()',
          'line 13',
        ].join('\n'),
        name: 'database_search.py',
      },
      oldFile: {
        cacheKey: 'old',
        contents: [
          'line 1',
          'favorite.click()',
          'line 3',
          'line 4',
          'line 5',
          'line 6',
          'line 7',
          'favorite.count()',
          'line 9',
          'line 10',
          'line 11',
          'database.write_order()',
          'line 13',
        ].join('\n'),
        name: 'database_search.py',
      },
      patch: [
        'diff --git a/database_search.py b/database_search.py',
        'index 1111111..2222222 100644',
        '--- a/database_search.py',
        '+++ b/database_search.py',
        '@@ -1,5 +1,5 @@',
        ' line 1',
        '-favorite.click()',
        '+favorite.drag()',
        ' line 3',
        ' line 4',
        ' line 5',
        '@@ -6,5 +6,5 @@',
        ' line 6',
        ' line 7',
        '-favorite.count()',
        '+favorite.row_count()',
        ' line 9',
        ' line 10',
        '@@ -11,3 +11,3 @@',
        ' line 11',
        '-database.write_order()',
        '+database.commit_order()',
        ' line 13',
        '',
      ].join('\n'),
    },
  ],
  status: 'modified',
});

const walkthroughViewCovering = (coveredHunk: WalkthroughHunk) =>
  buildWalkthroughView({
    ...walkthrough(),
    chapters: [
      {
        blurb: 'Main',
        icon: 'path',
        id: 'main',
        stops: [
          {
            ...group({ hunks: [coveredHunk], id: `covered-${coveredHunk.id}` }),
            importance: 'normal',
            prose: 'Covers the hunk.',
          },
        ],
        title: 'Main',
      },
    ],
    support: [],
  })!;

test('uncovered walkthrough files preserve uncovered hunks from partially covered sections', () => {
  const file = multiHunkFile();
  const section = file.sections[0];
  const view = walkthroughViewCovering({
    ...appHunk,
    anchor: { ...appHunk.anchor, sectionId: section.id },
    id: `${section.id}:h1`,
    path: file.path,
  });

  const uncoveredFiles = getUncoveredWalkthroughFiles([file], view, false);

  expect(uncoveredFiles).toHaveLength(1);
  expect(uncoveredFiles[0].sections).toHaveLength(1);
  expect(uncoveredFiles[0].sections[0].patch).not.toContain('favorite.drag()');
  expect(uncoveredFiles[0].sections[0].patch).toContain('favorite.row_count()');
  expect(uncoveredFiles[0].sections[0].patch).toContain('database.commit_order()');
  expect(
    parseSectionDiffWithOptions(uncoveredFiles[0], uncoveredFiles[0].sections[0], false).hunks,
  ).toHaveLength(2);
  expect(getUncoveredWalkthroughFileLineItems([file], view, false)).toEqual([
    { added: 2, deleted: 2, path: file.path },
  ]);
});

test('uncovered walkthrough file fingerprints change with the uncovered hunk set', () => {
  const file = multiHunkFile();
  const section = file.sections[0];
  const viewCoveringFirst = walkthroughViewCovering(
    hunk({
      added: 1,
      deleted: 1,
      display: 'database_search.py:2',
      id: `${section.id}:h1`,
      path: file.path,
      sectionId: section.id,
      status: 'modified',
    }),
  );
  const viewCoveringSecond = walkthroughViewCovering(
    hunk({
      added: 1,
      deleted: 1,
      display: 'database_search.py:8',
      id: `${section.id}:h2`,
      path: file.path,
      sectionId: section.id,
      status: 'modified',
    }),
  );

  const uncoveredAfterFirst = getUncoveredWalkthroughFiles([file], viewCoveringFirst, false);
  const uncoveredAfterSecond = getUncoveredWalkthroughFiles([file], viewCoveringSecond, false);

  expect(uncoveredAfterFirst).toHaveLength(1);
  expect(uncoveredAfterSecond).toHaveLength(1);
  expect(uncoveredAfterFirst[0].sections.map((section) => section.id)).toEqual(
    uncoveredAfterSecond[0].sections.map((section) => section.id),
  );
  expect(uncoveredAfterFirst[0].fingerprint).not.toBe(uncoveredAfterSecond[0].fingerprint);
});

test('focusChangedFileForHunks renders only the matching hunk', () => {
  const file = multiHunkFile();
  const section = file.sections[0];
  const focused = focusChangedFileForHunks(file, section, [
    hunk({
      added: 1,
      deleted: 1,
      display: 'database_search.py:2',
      id: `${section.id}:h1`,
      path: file.path,
      sectionId: section.id,
      status: 'modified',
    }),
  ]);

  expect(focused).not.toBeNull();
  expect(focused!.fingerprint).not.toBe(file.fingerprint);
  expect(focused!.sections).toHaveLength(1);
  expect(focused!.sections[0].id).toBe(section.id);
  expect(focused!.sections[0].newFile).toBeUndefined();
  expect(focused!.sections[0].oldFile).toBeUndefined();
  expect(focused!.sections[0].patch).toContain('favorite.drag()');
  expect(focused!.sections[0].patch).not.toContain('database.commit_order()');

  const parsed = parseSectionDiffWithOptions(focused!, focused!.sections[0], false);
  expect(parsed.hunks).toHaveLength(1);
  expect(parsed.hunks[0].additionStart).toBe(1);
});

test('focusChangedFileForHunks renders selected hunks in agent order', () => {
  const file = multiHunkFile();
  const section = file.sections[0];
  const focused = focusChangedFileForHunks(file, section, [
    hunk({
      added: 1,
      deleted: 1,
      display: 'database_search.py:12',
      id: `${section.id}:h3`,
      path: file.path,
      sectionId: section.id,
      status: 'modified',
    }),
    hunk({
      added: 1,
      deleted: 1,
      display: 'database_search.py:2',
      id: `${section.id}:h1`,
      path: file.path,
      sectionId: section.id,
      status: 'modified',
    }),
  ]);

  expect(focused).not.toBeNull();
  expect(focused!.sections[0].patch).toContain('database.commit_order()');
  expect(focused!.sections[0].patch).toContain('favorite.drag()');
  expect(focused!.sections[0].patch).not.toContain('favorite.row_count()');
  expect(focused!.sections[0].patch.indexOf('database.commit_order()')).toBeLessThan(
    focused!.sections[0].patch.indexOf('favorite.drag()'),
  );
  expect(parseSectionDiffWithOptions(focused!, focused!.sections[0], false).hunks).toHaveLength(2);
});

test('focusChangedFileForHunks uses exact hunk ids instead of broad anchor ranges', () => {
  const file = multiHunkFile();
  const section = file.sections[0];
  const focused = focusChangedFileForHunks(file, section, [
    {
      added: 1,
      anchor: {
        display: 'database_search.py:12',
        endLine: 12,
        sectionId: section.id,
        side: 'additions',
        startLine: 2,
      },
      deleted: 1,
      id: `${section.id}:h3`,
      path: file.path,
      status: 'modified',
    },
  ]);

  expect(focused).not.toBeNull();
  expect(focused!.sections[0].patch).toContain('database.commit_order()');
  expect(focused!.sections[0].patch).not.toContain('favorite.drag()');
  expect(focused!.sections[0].patch).not.toContain('favorite.row_count()');
});

test('focusChangedFileForHunks keeps deferred hunk sections visible and loadable', () => {
  const file = multiHunkFile();
  const section = {
    ...file.sections[0],
    loadState: 'deferred' as const,
    summary: {
      canLoad: true,
      reason: 'File is 2 MiB and will be loaded on demand.',
      size: 2_000_000,
    },
  };
  const focused = focusChangedFileForHunks({ ...file, sections: [section] }, section, [
    hunk({
      added: 1,
      deleted: 1,
      display: 'database_search.py:2',
      id: `${section.id}:h1`,
      path: file.path,
      sectionId: section.id,
      status: 'modified',
    }),
  ]);

  expect(focused).not.toBeNull();
  expect(focused!.fingerprint).not.toBe(file.fingerprint);
  expect(focused!.sections).toHaveLength(1);
  expect(focused!.sections[0]).toMatchObject({
    id: section.id,
    loadState: 'deferred',
    patch: section.patch,
    summary: {
      canLoad: true,
      reason: 'File is 2 MiB and will be loaded on demand.',
    },
  });
});

test('focusChangedFileForHunks keeps synthetic hunks as whole sections after content loads', () => {
  const file = multiHunkFile();
  const section = file.sections[0];
  const focused = focusChangedFileForHunks(file, section, [
    hunk({
      added: 0,
      deleted: 0,
      display: 'database_search.py',
      id: `${section.id}:h1`,
      kind: 'synthetic',
      path: file.path,
      sectionId: section.id,
      status: 'modified',
    }),
  ]);

  expect(focused).not.toBeNull();
  expect(focused!.sections).toHaveLength(1);
  expect(focused!.sections[0].patch).toBe(section.patch);
  expect(focused!.sections[0].newFile).toBe(section.newFile);
  expect(focused!.sections[0].oldFile).toBe(section.oldFile);
  expect(
    parseSectionDiffWithOptions(focused!, focused!.sections[0], false).hunks.length,
  ).toBeGreaterThan(1);
});

test('focusChangedFileForHunks fails closed for unresolved hunk ids', () => {
  const file = multiHunkFile();
  const section = file.sections[0];

  expect(
    focusChangedFileForHunks(file, section, [
      hunk({
        added: 1,
        deleted: 1,
        display: 'database_search.py:12',
        id: `${section.id}:h99`,
        path: file.path,
        sectionId: section.id,
        status: 'modified',
      }),
    ]),
  ).toBeNull();
});

test('resolveWalkthroughHunkRuns groups adjacent same-file hunks without reordering', () => {
  const file = multiHunkFile();
  const other: ChangedFile = {
    fingerprint: 'other',
    path: 'other.py',
    sections: [
      {
        binary: false,
        id: 'other.py:unstaged',
        kind: 'unstaged',
        loadState: 'ready',
        patch: '@@ -1 +1 @@\n-old\n+new\n',
      },
    ],
    status: 'modified',
  };
  const item = {
    ...group({
      hunks: [
        hunk({
          added: 1,
          deleted: 1,
          display: 'database_search.py:2',
          id: 'database_search.py:unstaged:h1',
          path: 'database_search.py',
          sectionId: 'database_search.py:unstaged',
          status: 'modified',
        }),
        hunk({
          added: 1,
          deleted: 1,
          display: 'other.py:1',
          id: 'other.py:unstaged:h1',
          path: 'other.py',
          sectionId: 'other.py:unstaged',
          status: 'modified',
        }),
        hunk({
          added: 1,
          deleted: 1,
          display: 'database_search.py:12',
          id: 'database_search.py:unstaged:h3',
          path: 'database_search.py',
          sectionId: 'database_search.py:unstaged',
          status: 'modified',
        }),
      ],
      id: 'cross',
    }),
  };

  expect(
    resolveWalkthroughHunkRuns(item, [file, other]).map((run) => run.resolved.file.path),
  ).toEqual(['database_search.py', 'other.py', 'database_search.py']);

  const grouped = resolveWalkthroughHunkRuns(
    { ...item, hunks: [item.hunks[0], item.hunks[2], item.hunks[1]] },
    [file, other],
  );
  expect(grouped.map((run) => run.hunks.map((hunk) => hunk.id))).toEqual([
    ['database_search.py:unstaged:h1', 'database_search.py:unstaged:h3'],
    ['other.py:unstaged:h1'],
  ]);
});

test('getWalkthroughRunNote combines header notes for grouped hunks', () => {
  const file = multiHunkFile();
  const section = file.sections[0];
  const item = {
    ...group({
      hunks: [
        hunk({
          added: 1,
          deleted: 1,
          display: 'database_search.py:2',
          id: `${section.id}:h1`,
          path: file.path,
          sectionId: section.id,
          status: 'modified',
        }),
        hunk({
          added: 1,
          deleted: 1,
          display: 'database_search.py:12',
          id: `${section.id}:h3`,
          path: file.path,
          sectionId: section.id,
          status: 'modified',
        }),
      ],
      id: 'drag',
    }),
    notes: [
      {
        body: 'This line turns the widget into a reorderable list.',
        hunkId: `${section.id}:h1`,
      },
      {
        body: 'This hunk persists the final order.',
        hunkId: `${section.id}:h3`,
      },
    ],
  };
  const runs = resolveWalkthroughHunkRuns(item, [file]);

  expect(runs).toHaveLength(1);
  expect(getWalkthroughRunNote(item, runs[0])).toBe(
    'This line turns the widget into a reorderable list. This hunk persists the final order.',
  );
});
