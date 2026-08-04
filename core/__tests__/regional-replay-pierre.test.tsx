/**
 * @vitest-environment jsdom
 */

import { expect, test } from 'vite-plus/test';
import { projectRegionAwareReplay } from '../lib/region-aware-replay.ts';
import type { ChangedFile } from '../types.ts';
import { createChangedFileWithPatch } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';
import { ReviewCodeViewHarness } from './helpers/review-code-view.tsx';

test('Pierre mounts paired regional replay cards into real split-column annotation slots', async () => {
  const projection = projectRegionAwareReplay({
    earlierBase: 'before\nold\nafter\n',
    earlierHead: 'before\nprior\nafter\n',
    laterBase: 'before\nbase\nafter\n',
    laterHead: 'before\ncurrent\nafter\n',
    path: 'src/pierre.txt',
  });
  const file = {
    ...createChangedFileWithPatch(
      'src/pierre.txt',
      'diff --git a/src/pierre.txt b/src/pierre.txt\n@@ -1,3 +1,3 @@\n before\n-base\n+current\n after\n',
    ),
    regionalReplay: projection,
  } satisfies ChangedFile;
  const view = await renderReact(<ReviewCodeViewHarness disableWorkerPool files={[file]} />);

  try {
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-replay-pair]')).toHaveLength(2);
      const shadowRoot = view.container.querySelector('diffs-container')?.shadowRoot;
      expect(shadowRoot).not.toBeNull();
      expect(shadowRoot?.querySelector('[data-deletions]')).not.toBeNull();
      expect(shadowRoot?.querySelector('[data-additions]')).not.toBeNull();
    });
    const cards = [...view.container.querySelectorAll<HTMLElement>('[data-replay-pair]')];
    const pairId = cards[0]?.dataset.replayPair;
    const annotationSlots = cards.map((card) => card.closest('[slot]')?.getAttribute('slot'));

    expect(cards.map((card) => card.dataset.replayPair)).toEqual([pairId, pairId]);
    expect(cards.map((card) => card.dataset.replayFragment).toSorted()).toEqual([
      'additions',
      'deletions',
    ]);
    expect(annotationSlots.toSorted()).toEqual([
      'annotation-additions-3',
      'annotation-deletions-3',
    ]);
    const hiddenDuplicate = cards.find((card) => card.dataset.replayFragment === 'additions');
    expect(hiddenDuplicate?.getAttribute('aria-hidden')).toBe('true');
    expect(hiddenDuplicate?.hasAttribute('inert')).toBe(true);
  } finally {
    await view.cleanup();
  }
});
