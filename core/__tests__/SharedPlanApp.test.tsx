/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { PlanCommentCard } from '../app/components/PlanEditorView.tsx';
import { getSharedPlanDownloadContent, PlanReviewSurface } from '../SharedPlanApp.tsx';
import type { PlanCommentThread, SharedPlanSnapshot } from '../types.ts';
import { waitFor } from './helpers/react.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  ResizeObserver?: typeof ResizeObserver;
};
reactActEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
HTMLElement.prototype.scrollTo ??= function scrollTo() {};

test('read-only comments can reveal attached targets', async () => {
  const thread = {
    anchor: {
      block: {
        fingerprint: 'heading-fingerprint',
        path: [0],
        text: 'Ship plan sharing',
        type: 'heading',
      },
      kind: 'block',
      version: 1,
    },
    createdAt: '2026-06-25T00:00:00.000Z',
    createdBy: { id: 'reviewer', name: 'Reviewer' },
    id: 'thread-1',
    messages: [
      {
        author: { id: 'reviewer', name: 'Reviewer' },
        body: 'Review this target.',
        createdAt: '2026-06-25T00:00:00.000Z',
        id: 'message-1',
        updatedAt: '2026-06-25T00:00:00.000Z',
      },
    ],
    status: 'open',
    updatedAt: '2026-06-25T00:00:00.000Z',
  } satisfies PlanCommentThread;
  const onReveal = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await using _resource = {
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  await act(async () => {
    root.render(
      <PlanCommentCard
        active={false}
        detached={false}
        onActivate={() => {}}
        onBodyChange={() => {}}
        onDelete={() => {}}
        onEmptyBlur={() => {}}
        onHeightChange={() => {}}
        onReveal={onReveal}
        readOnly
        showDelete={false}
        thread={thread}
      />,
    );
  });
  const target = container.querySelector<HTMLButtonElement>('.plan-comment-target');
  expect(target?.disabled).toBe(false);
  await act(async () => target?.click());
  expect(onReveal).toHaveBeenCalledOnce();
});

test('shared plans render Markdown and comments read-only', async () => {
  const onDeleteShare = vi.fn();
  const confirmDelete = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const snapshot = {
    codiffVersion: '1.4.7',
    document: {
      content: '# Ship plan sharing\n\n- Keep walkthroughs stable\n',
      name: 'plan.md',
      title: 'Ship plan sharing',
    },
    exportedAt: '2026-06-25T00:00:00.000Z',
    kind: 'codiff-plan-share',
    preferences: {
      theme: 'system',
    },
    review: {
      threads: [
        {
          anchor: {
            block: {
              fingerprint: 'heading-fingerprint',
              path: [0],
              text: 'Ship plan sharing',
              type: 'heading',
            },
            kind: 'block',
            version: 1,
          },
          createdAt: '2026-06-25T00:00:00.000Z',
          createdBy: {
            email: 'reviewer@example.com',
            id: 'reviewer@example.com',
            name: 'Reviewer',
          },
          id: 'thread-1',
          messages: [
            {
              author: {
                email: 'reviewer@example.com',
                id: 'reviewer@example.com',
                name: 'Reviewer',
              },
              body: 'Do not regress walkthrough sharing.',
              createdAt: '2026-06-25T00:00:00.000Z',
              id: 'message-1',
              updatedAt: '2026-06-25T00:00:00.000Z',
            },
          ],
          status: 'open',
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
      ],
      version: 1,
    },
    source: {
      agent: 'codex',
      sessionId: 'thread-id',
    },
    version: 1,
  } satisfies SharedPlanSnapshot;

  expect(getSharedPlanDownloadContent(snapshot)).toContain(
    [
      '## Comments',
      '',
      '### Comment 1: Heading · Ship plan sharing',
      '',
      '_Status: Open_',
      '',
      '**Reviewer (reviewer@example.com)** · 2026-06-25T00:00:00.000Z',
      '',
      'Do not regress walkthrough sharing.',
    ].join('\n'),
  );

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  await using _resource = {
    async [Symbol.asyncDispose]() {
      if (root) {
        await act(async () => root?.unmount());
      }
      container.remove();
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<PlanReviewSurface onDeleteShare={onDeleteShare} snapshot={snapshot} />);
  });
  await waitFor(() => {
    expect(container.querySelector('.mdx-editor-content h1')?.textContent).toBe(
      'Ship plan sharing',
    );
    expect(container.querySelector('.plan-comment-thread')?.textContent).toContain(
      'Do not regress walkthrough sharing.',
    );
  });
  expect(container.querySelector('.plan-title')?.textContent).toBe('Ship plan sharing');
  expect(container.querySelector('.plan-header.workspace-top-bar')).not.toBeNull();
  expect(container.querySelector('.codiff-file-path')?.textContent).toBe('plan.md');
  expect(
    container.querySelector('.codiff-header-toggle-static .codiff-file-path')?.textContent,
  ).toBe('plan.md');
  expect(container.querySelector('button[aria-label="Download plan"] svg')).not.toBeNull();
  const deleteShare = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Delete shared plan"]',
  );
  expect(deleteShare?.closest('.plan-file-actions')).not.toBeNull();
  await act(async () => deleteShare?.click());
  expect(confirmDelete).toHaveBeenCalledWith('Delete this shared plan? This cannot be undone.');
  expect(onDeleteShare).not.toHaveBeenCalled();
  confirmDelete.mockReturnValue(true);
  await act(async () => deleteShare?.click());
  await waitFor(() => expect(onDeleteShare).toHaveBeenCalledOnce());
  expect(
    [...container.querySelectorAll<HTMLElement>('[contenteditable]')].every(
      (element) => element.getAttribute('contenteditable') === 'false',
    ),
  ).toBe(true);
  expect(container.querySelector('.review-comment-delete')).toBeNull();
  expect(container.querySelector('.plan-comment-affordance')).toBeNull();
  const target = container.querySelector('.plan-comment-target');
  expect(target?.closest('.plan-comment-heading')).not.toBeNull();
  expect(target?.closest('.review-comment-header')).not.toBeNull();
  expect(container.querySelector('.plan-comment-thread-title')).toBeNull();
});

test('shared plans collapse resolved comments without rendering their annotations', async () => {
  const snapshot = {
    codiffVersion: '1.5.0',
    document: {
      content: '# Current plan\n',
      name: 'plan.md',
      title: 'Current plan',
    },
    exportedAt: '2026-06-25T00:00:00.000Z',
    kind: 'codiff-plan-share',
    preferences: { theme: 'system' },
    review: {
      threads: [
        {
          anchor: {
            block: {
              fingerprint: 'removed-heading-fingerprint',
              path: [0],
              text: 'Removed heading',
              type: 'heading',
            },
            kind: 'block',
            version: 1,
          },
          createdAt: '2026-06-24T00:00:00.000Z',
          createdBy: { id: 'reviewer', name: 'Reviewer' },
          id: 'resolved-thread',
          messages: [
            {
              author: { id: 'reviewer', name: 'Reviewer' },
              body: 'This comment was handled.',
              createdAt: '2026-06-24T00:00:00.000Z',
              id: 'resolved-message',
              updatedAt: '2026-06-25T00:00:00.000Z',
            },
          ],
          resolution: {
            reason: 'anchor-removed',
            resolvedAt: '2026-06-25T00:00:00.000Z',
          },
          status: 'resolved',
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
      ],
      version: 1,
    },
    version: 1,
  } satisfies SharedPlanSnapshot;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await using _resource = {
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  await act(async () => {
    root.render(<PlanReviewSurface snapshot={snapshot} />);
  });
  await waitFor(() => {
    expect(container.querySelector('.plan-resolved-comments')).not.toBeNull();
  });
  const resolvedSection = container.querySelector<HTMLDetailsElement>('.plan-resolved-comments');
  expect(resolvedSection?.open).toBe(false);
  expect(resolvedSection?.querySelector('summary')?.textContent).toBe('Resolved comments (1)');
  expect(resolvedSection?.querySelector('.plan-comment-thread.resolved')?.textContent).toContain(
    'Resolved after target removal',
  );
  expect(container.querySelector('[data-mdx-annotation-block~="resolved-thread"]')).toBeNull();
});

test('shared plans do not render active HTML from documents or comments', async () => {
  const snapshot = {
    codiffVersion: '1.4.7',
    document: {
      content:
        '# Safe plan\n\n<button onclick="document.body.dataset.probe = \'active\'">Run</button>\n\n<iframe src="https://example.com"></iframe>\n',
      name: 'plan.md',
      title: 'Safe plan',
    },
    exportedAt: '2026-06-25T00:00:00.000Z',
    kind: 'codiff-plan-share',
    preferences: { theme: 'system' },
    review: {
      threads: [
        {
          anchor: {
            block: {
              fingerprint: 'heading-fingerprint',
              path: [0],
              text: 'Safe plan',
              type: 'heading',
            },
            kind: 'block',
            version: 1,
          },
          createdAt: '2026-06-25T00:00:00.000Z',
          createdBy: { id: 'reviewer', name: 'Reviewer' },
          id: 'thread-1',
          messages: [
            {
              author: { id: 'reviewer', name: 'Reviewer' },
              body: '<img src=x onerror="document.body.dataset.probe = \'active\'">',
              createdAt: '2026-06-25T00:00:00.000Z',
              id: 'message-1',
              updatedAt: '2026-06-25T00:00:00.000Z',
            },
          ],
          status: 'open',
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
      ],
      version: 1,
    },
    version: 1,
  } satisfies SharedPlanSnapshot;

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  await using _resource = {
    async [Symbol.asyncDispose]() {
      if (root) {
        await act(async () => root?.unmount());
      }
      container.remove();
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<PlanReviewSurface snapshot={snapshot} />);
  });
  await waitFor(() => {
    expect(container.querySelector('.mdx-editor-content h1')?.textContent).toBe('Safe plan');
  });
  expect(container.querySelector('button[onclick]')).toBeNull();
  expect(container.querySelector('iframe')).toBeNull();
  expect(container.querySelector('img[onerror]')).toBeNull();
});
