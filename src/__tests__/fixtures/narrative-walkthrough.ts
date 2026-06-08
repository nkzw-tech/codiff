import type { NarrativeWalkthrough, ReviewSource } from '../../types.ts';

const createWalkthroughAnchor = (id: string, path: string) => ({
  added: 1,
  anchor: { display: path, sectionId: `${path}:unstaged`, side: 'both' as const },
  deleted: 1,
  granularity: 'file' as const,
  id,
  path,
  status: 'modified' as const,
});

export const createLargeWalkthrough = ({
  source,
  stopCount = 1,
  stopFileCount,
  supportFileCount,
}: {
  source: ReviewSource;
  stopCount?: number;
  stopFileCount: number;
  supportFileCount: number;
}) =>
  ({
    agent: 'codex',
    chapters: [
      {
        blurb: 'Review the implementation.',
        icon: 'gear',
        id: 'impl',
        stops: Array.from({ length: stopCount }, (_, stopIndex) => {
          const prefix = stopCount === 1 ? 'stop' : `stop-${stopIndex}`;
          return {
            anchors: Array.from({ length: stopFileCount }, (_, index) =>
              createWalkthroughAnchor(`${prefix}-${index}`, `src/${prefix}-${index}.ts`),
            ),
            body: `Review step ${stopIndex + 1}.`,
            id: `implementation-path-${stopIndex}`,
            importance: 'critical',
            summary: 'The implementation path carries several files.',
            title: `Implementation path ${stopIndex + 1}`,
          };
        }),
        title: 'Implementation',
      },
    ],
    focus: 'Focus.',
    generatedAt: '2026-06-07T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source,
    support:
      supportFileCount > 0
        ? [
            {
              files: Array.from({ length: supportFileCount }, (_, index) =>
                createWalkthroughAnchor(`support-${index}`, `src/support-${index}.ts`),
              ),
              id: 'support',
              note: 'Supporting.',
              title: 'Support',
            },
          ]
        : [],
    title: 'Narrative',
    version: 3,
  }) satisfies NarrativeWalkthrough;
