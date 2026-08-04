/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { CommitScopePanel } from '../app/components/CommitScopePanel.tsx';
import type { GitSha, ReviewCommitListEntry } from '../types.ts';
import { renderReact } from './helpers/react.tsx';

const gitSha = (value: string) => value.repeat(40) as GitSha;

const commit = (
  name: string,
  parent: string,
  subject: string,
  authoredAt: string,
): ReviewCommitListEntry => ({
  authoredAt,
  authorName: 'Author',
  parentShas: [gitSha(parent)],
  sha: gitSha(name),
  shortSha: name.repeat(7),
  subject,
});

const commits = [
  commit('a', '0', 'Add the first change', '2026-07-01T00:00:00.000Z'),
  commit('b', 'a', 'Refine the first change', '2026-07-02T00:00:00.000Z'),
  commit('c', 'b', 'Add the second change', '2026-07-03T00:00:00.000Z'),
] as const;

const openRangePicker = async (container: HTMLElement) => {
  const button = [...container.querySelectorAll('button')].find(
    ({ textContent }) => textContent?.trim() === 'View commit range',
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
};

test('selects one inclusive range from a canonical commit stack', async () => {
  const onSelectCommitRange = vi.fn();
  const onClear = vi.fn();
  const app = await renderReact(
    <CommitScopePanel
      commits={commits}
      onClear={onClear}
      onSelectCommitRange={onSelectCommitRange}
    />,
  );

  try {
    await openRangePicker(app.container);
    const rows = app.container.querySelectorAll<HTMLButtonElement>('.commit-range-row');
    expect([...rows].map((row) => row.textContent)).toEqual([
      expect.stringContaining('Add the first change'),
      expect.stringContaining('Refine the first change'),
      expect.stringContaining('Add the second change'),
    ]);

    await act(async () => rows[0]!.click());
    expect(onSelectCommitRange).toHaveBeenLastCalledWith(null);
    expect(app.container.querySelector('.commit-scope-heading')?.textContent).toContain(
      'Choose To',
    );

    await act(async () => rows[2]!.click());
    expect(onSelectCommitRange).toHaveBeenLastCalledWith({
      fromSha: commits[0].sha,
      toSha: commits[2].sha,
    });

    await app.rerender(
      <CommitScopePanel
        commits={commits}
        onClear={onClear}
        onSelectCommitRange={onSelectCommitRange}
        selectedCommitRange={{ fromSha: commits[0].sha, toSha: commits[2].sha }}
      />,
    );
    expect(app.container.querySelector('.commit-scope-heading')?.textContent).toContain(
      '3 selected commits',
    );

    const clearButton = app.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear commit range"]',
    );
    await act(async () => clearButton?.click());
    expect(onClear).toHaveBeenCalledOnce();
  } finally {
    await app.cleanup();
  }
});

test('supports partial clear and a one-commit range while disabling earlier rows', async () => {
  const onSelectCommitRange = vi.fn();
  const onClear = vi.fn();
  const app = await renderReact(
    <CommitScopePanel
      commits={commits}
      onClear={onClear}
      onSelectCommitRange={onSelectCommitRange}
    />,
  );

  try {
    await openRangePicker(app.container);
    let rows = app.container.querySelectorAll<HTMLButtonElement>('.commit-range-row');
    await act(async () => rows[1]!.click());
    rows = app.container.querySelectorAll<HTMLButtonElement>('.commit-range-row');
    expect(rows[0]!.disabled).toBe(true);
    expect(rows[1]!.disabled).toBe(false);
    expect(rows[2]!.disabled).toBe(false);

    const clearButton = app.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear commit range"]',
    );
    await act(async () => clearButton?.click());
    expect(onClear).toHaveBeenCalledOnce();

    rows = app.container.querySelectorAll<HTMLButtonElement>('.commit-range-row');
    await act(async () => rows[1]!.click());
    await act(async () => rows[1]!.click());
    expect(onSelectCommitRange).toHaveBeenLastCalledWith({
      fromSha: commits[1].sha,
      toSha: commits[1].sha,
    });
  } finally {
    await app.cleanup();
  }
});

test('rejects a parallel To commit that is not descended from From', async () => {
  const mergeCommits = [
    commit('a', '0', 'Root', '2026-07-01T00:00:00.000Z'),
    commit('b', 'a', 'Left branch', '2026-07-02T00:00:00.000Z'),
    commit('c', 'a', 'Right branch', '2026-07-03T00:00:00.000Z'),
    {
      ...commit('d', 'b', 'Merge branches', '2026-07-04T00:00:00.000Z'),
      parentShas: [gitSha('b'), gitSha('c')],
    },
  ];
  const onSelectCommitRange = vi.fn();
  const app = await renderReact(
    <CommitScopePanel
      commits={mergeCommits}
      onClear={vi.fn()}
      onSelectCommitRange={onSelectCommitRange}
    />,
  );

  try {
    await openRangePicker(app.container);
    let rows = app.container.querySelectorAll<HTMLButtonElement>('.commit-range-row');
    await act(async () => rows[1]!.click());
    rows = app.container.querySelectorAll<HTMLButtonElement>('.commit-range-row');
    expect(rows[2]!.disabled).toBe(true);
    expect(rows[3]!.disabled).toBe(false);
    await act(async () => rows[2]!.click());
    expect(onSelectCommitRange).toHaveBeenCalledTimes(1);
  } finally {
    await app.cleanup();
  }
});

test('highlights graph-derived members of a merge range', async () => {
  const mergeCommits = [
    commit('a', '0', 'Root', '2026-07-01T00:00:00.000Z'),
    commit('b', 'a', 'Left branch', '2026-07-02T00:00:00.000Z'),
    commit('c', 'a', 'Right branch', '2026-07-03T00:00:00.000Z'),
    {
      ...commit('d', 'b', 'Merge branches', '2026-07-04T00:00:00.000Z'),
      parentShas: [gitSha('b'), gitSha('c')],
    },
  ];
  const app = await renderReact(
    <CommitScopePanel
      commits={mergeCommits}
      onClear={vi.fn()}
      onSelectCommitRange={vi.fn()}
      selectedCommitRange={{ fromSha: gitSha('c'), toSha: gitSha('d') }}
    />,
  );

  try {
    const rows = app.container.querySelectorAll<HTMLButtonElement>('.commit-range-row');
    expect([...rows].map((row) => row.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'true',
      'true',
    ]);
    expect(app.container.querySelector('.commit-scope-heading')?.textContent).toContain(
      '3 selected commits',
    );
  } finally {
    await app.cleanup();
  }
});
