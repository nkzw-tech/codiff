/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test } from 'vite-plus/test';
import { ReviewCommitRef } from '../app/components/CommitRefTooltip.tsx';
import type { GitSha, ReviewCommitListEntry } from '../types.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

test('review commit tooltips retain the complete commit diffstat', async () => {
  const commit = {
    authoredAt: '2026-07-20T01:00:00.000Z',
    authorName: 'Ada Lovelace',
    diffStat: { additions: 7, deletions: 3, filesChanged: 2 },
    parentShas: ['b'.repeat(40) as GitSha],
    sha: 'c'.repeat(40) as GitSha,
    shortSha: 'ccccccc',
    subject: 'Add the second change',
  } satisfies ReviewCommitListEntry;
  const app = await renderReact(<ReviewCommitRef commit={commit} />);

  try {
    const trigger = app.container.querySelector<HTMLElement>('.git-commit-ref-trigger');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.focus());
    await waitFor(() => {
      expect(document.body.querySelector('.git-commit-tooltip-diffstat')?.textContent).toBe('+7−3');
    });
  } finally {
    await app.cleanup();
  }
});
