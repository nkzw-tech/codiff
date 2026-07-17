/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import {
  nextWalkthroughResponseLabelIndex,
  WalkthroughProgress,
  walkthroughResponseLabels,
} from '../app/components/walkthrough/WalkthroughProgress.tsx';

afterEach(() => {
  vi.useRealTimers();
});

test('cycles through polished response labels once per walkthrough', () => {
  expect(walkthroughResponseLabels).toEqual([
    'Building walkthrough…',
    'Composing walkthrough…',
    'Writing walkthrough…',
    'Assembling walkthrough…',
    'Creating walkthrough…',
    'Producing walkthrough…',
  ]);
  expect(
    walkthroughResponseLabels.map((_, index) => nextWalkthroughResponseLabelIndex(index)),
  ).toEqual([1, 2, 3, 4, 5, 0]);
});

test('reserves timer space, reveals 3s without shifting, and resets for each stage', async () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = createRoot(container);

  await using _resource = {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.unmount());
      root = null;
      container.remove();
    },
  };
  await act(async () => {
    root?.render(<WalkthroughProgress phase={null} responseLabelIndex={0} stageRevision={0} />);
  });
  const timer = () => container.querySelector<HTMLElement>('.walkthrough-progress-timer');
  expect(container.textContent).toContain('Generating walkthrough…');
  expect(timer()?.textContent).toBe('0s');
  expect(timer()?.classList.contains('visible')).toBe(false);
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(timer()?.textContent).toBe('3s');
  expect(timer()?.classList.contains('visible')).toBe(true);
  await act(async () => {
    root?.render(
      <WalkthroughProgress phase="agent-generation" responseLabelIndex={0} stageRevision={1} />,
    );
  });
  expect(container.textContent).toContain('Analyzing changes…');
  expect(timer()?.textContent).toBe('0s');
  expect(timer()?.classList.contains('visible')).toBe(false);
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(timer()?.textContent).toBe('3s');
  await act(async () => {
    root?.render(
      <WalkthroughProgress phase="agent-generation" responseLabelIndex={0} stageRevision={1} />,
    );
  });
  expect(container.textContent).toContain('Analyzing changes…');
  expect(timer()?.textContent).toBe('3s');
  expect(timer()?.classList.contains('visible')).toBe(true);
  await act(async () => {
    root?.render(
      <WalkthroughProgress phase="response-received" responseLabelIndex={4} stageRevision={2} />,
    );
  });
  expect(container.textContent).toContain('Creating walkthrough…');
  expect(timer()?.textContent).toBe('0s');
  expect(timer()?.classList.contains('visible')).toBe(false);
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(timer()?.textContent).toBe('3s');
  expect(timer()?.classList.contains('visible')).toBe(true);
});
