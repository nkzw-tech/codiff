/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test } from 'vite-plus/test';
import type { NarrativeNavigation } from '../app/components/walkthrough/useNarrativeNavigation.ts';
import { useNarrativeNavigation } from '../app/components/walkthrough/useNarrativeNavigation.ts';
import type { NarrativeWalkthrough, WalkthroughStop } from '../types.ts';
import { renderReact } from './helpers/react.tsx';

const stop = (id: string): WalkthroughStop => ({
  added: 1,
  deleted: 0,
  hunkIds: [],
  hunks: [],
  id,
  importance: 'normal',
  prose: id,
  title: id,
});

const walkthrough: NarrativeWalkthrough = {
  agent: 'codex',
  chapters: [
    {
      blurb: 'Main path',
      icon: 'path',
      id: 'main',
      stops: [stop('first'), stop('second'), stop('third')],
      title: 'Main',
    },
  ],
  focus: 'Focus',
  generatedAt: '2026-06-08T00:00:00.000Z',
  kind: 'narrative',
  repo: { branch: 'main', root: '/repo' },
  source: { type: 'working-tree' },
  support: [],
  title: 'Walkthrough',
  version: 4,
};

function NavigationHarness({
  onNavigation,
}: {
  onNavigation: (navigation: NarrativeNavigation) => void;
}) {
  const navigation = useNarrativeNavigation(walkthrough, []);
  onNavigation(navigation);
  return null;
}

test('clicked walkthrough stops hold selection until target reached or user scroll input releases it', async () => {
  const navigationRef: { current: NarrativeNavigation | null } = { current: null };
  const getNavigation = () => {
    if (!navigationRef.current) {
      throw new Error('Navigation did not render.');
    }
    return navigationRef.current;
  };

  const view = await renderReact(
    <NavigationHarness onNavigation={(next) => (navigationRef.current = next)} />,
  );

  try {
    expect(getNavigation().index).toBe(0);

    await act(async () => {
      getNavigation().goStop(2);
    });
    expect(getNavigation().index).toBe(2);

    await act(async () => {
      getNavigation().syncIndexFromScroll(1);
    });
    expect(getNavigation().index).toBe(2);

    await act(async () => {
      getNavigation().syncIndexFromScroll(2);
    });
    expect(getNavigation().index).toBe(2);

    await act(async () => {
      getNavigation().syncIndexFromScroll(1);
    });
    expect(getNavigation().index).toBe(1);

    await act(async () => {
      getNavigation().goStop(2);
    });
    expect(getNavigation().index).toBe(2);

    await act(async () => {
      getNavigation().releaseStopScrollLock();
      getNavigation().syncIndexFromScroll(1);
    });
    expect(getNavigation().index).toBe(1);
  } finally {
    await view.cleanup();
  }
});

test('support navigation holds support mode until the support block is reached', async () => {
  const navigationRef: { current: NarrativeNavigation | null } = { current: null };
  const getNavigation = () => {
    if (!navigationRef.current) {
      throw new Error('Navigation did not render.');
    }
    return navigationRef.current;
  };

  const view = await renderReact(
    <NavigationHarness onNavigation={(next) => (navigationRef.current = next)} />,
  );

  try {
    await act(async () => {
      getNavigation().goStop(2);
    });
    expect(getNavigation().index).toBe(2);

    await act(async () => {
      getNavigation().openSupport();
    });
    expect(getNavigation().mode).toBe('support');
    expect(getNavigation().supportVisited).toBe(true);

    await act(async () => {
      getNavigation().syncIndexFromScroll(1);
    });
    expect(getNavigation().mode).toBe('support');
    expect(getNavigation().index).toBe(2);

    await act(async () => {
      getNavigation().syncSupportFromScroll();
    });
    expect(getNavigation().mode).toBe('support');

    await act(async () => {
      getNavigation().releaseStopScrollLock();
      getNavigation().syncIndexFromScroll(1);
    });
    expect(getNavigation().mode).toBe('stop');
    expect(getNavigation().index).toBe(1);
  } finally {
    await view.cleanup();
  }
});
