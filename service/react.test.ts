/**
 * @vitest-environment jsdom
 */

import type { GitSha, ResolvedReviewSource, SharedWalkthroughSnapshot } from '@nkzw/codiff-core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import {
  createSharedReviewCommentCapabilities,
  resolveSubmittedShareReply,
  resolveSubmittedShareThread,
  SharedWalkthroughApp,
} from './react.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  ResizeObserver?: typeof ResizeObserver;
};
reactActEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollBy ??= function scrollBy() {};
HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
HTMLElement.prototype.scrollTo ??= function scrollTo() {};

const comment = {
  body: 'Keep this visible while it saves.',
  filePath: 'src/review.ts',
  lineNumber: 12,
  sectionId: 'src/review.ts:unstaged',
  side: 'additions',
} as const;

const message = {
  authorImage: 'https://github.com/ada.png',
  authorName: 'Ada Lovelace',
  authorUsername: 'ada',
  body: comment.body,
  canEdit: true,
  createdAt: '2026-07-16T12:00:00.000Z',
  id: 'message-1',
  threadId: 'thread-1',
  updatedAt: '2026-07-16T12:00:00.000Z',
};

test('resolves submitted share comments to their persisted server identity', () => {
  expect(
    resolveSubmittedShareReply({
      canResolveThread: true,
      comment: { ...comment, threadId: 'thread-1' },
      result: message,
    }),
  ).toMatchObject({
    author: {
      avatarUrl: 'https://github.com/ada.png',
      login: 'ada',
      name: 'Ada Lovelace',
    },
    body: comment.body,
    canDelete: true,
    canEdit: true,
    canResolveThread: true,
    id: 'message-1',
    submittedAt: '2026-07-16T12:00:00.000Z',
    threadId: 'thread-1',
  });

  expect(
    resolveSubmittedShareThread({
      canResolveThread: true,
      comment,
      result: {
        id: 'thread-1',
        messages: { items: [{ node: message }] },
      },
    }),
  ).toMatchObject({
    body: comment.body,
    id: 'message-1',
    threadId: 'thread-1',
  });
});

test('rejects incomplete mutation results instead of inventing a submitted comment', () => {
  expect(() =>
    resolveSubmittedShareThread({
      canResolveThread: false,
      comment,
      result: { id: 'thread-1', messages: { items: [] } },
    }),
  ).toThrow('Unable to load the submitted walkthrough comment.');
});

test('maps every shared discussion callback to share capabilities without provider naming', () => {
  const onDeleteComment = vi.fn(async () => {});
  const onDeleteGeneralComment = vi.fn(async () => {});
  const onReplyGeneralComment = vi.fn(async () => {});
  const onResolveDiscussion = vi.fn(async () => {});
  const onSignIn = vi.fn();
  const onSubmitComment = vi.fn(async () => ({
    author: { login: 'ada', name: 'Ada' },
    body: comment.body,
    destination: 'share' as const,
    filePath: comment.filePath,
    id: 'submitted',
    isReadOnly: true as const,
    lineNumber: comment.lineNumber,
    sectionId: comment.sectionId,
    side: comment.side,
  }));
  const onSubmitGeneralComment = vi.fn(async () => {});
  const onUpdateComment = vi.fn(async () => {});
  const onUpdateGeneralComment = vi.fn(async () => {});

  const capabilities = createSharedReviewCommentCapabilities({
    canComment: true,
    onDeleteComment,
    onDeleteGeneralComment,
    onReplyGeneralComment,
    onResolveDiscussion,
    onSignIn,
    onSubmitComment,
    onSubmitGeneralComment,
    onUpdateComment,
    onUpdateGeneralComment,
  });

  expect(capabilities).toMatchObject({
    authoring: { canCreateInline: true },
    destination: 'share',
  });
  expect(capabilities?.inline).toEqual({
    onDelete: onDeleteComment,
    onResolve: onResolveDiscussion,
    onSubmit: onSubmitComment,
    onUpdate: onUpdateComment,
  });
  expect(capabilities?.general).toEqual({
    onCreate: onSubmitGeneralComment,
    onDelete: onDeleteGeneralComment,
    onReply: onReplyGeneralComment,
    onResolve: onResolveDiscussion,
    onUpdate: onUpdateGeneralComment,
  });
  expect(capabilities?.onSignIn).toBe(onSignIn);
});

test('signed-out shared review capabilities expose no mutation handlers', () => {
  const onSignIn = vi.fn();
  const mutation = vi.fn(async () => {});
  const capabilities = createSharedReviewCommentCapabilities({
    canComment: false,
    onDeleteComment: mutation,
    onDeleteGeneralComment: mutation,
    onReplyGeneralComment: mutation,
    onResolveDiscussion: mutation,
    onSignIn,
    onSubmitComment: async () => {
      throw new Error('Signed-out mutation must not be reachable.');
    },
    onSubmitGeneralComment: mutation,
    onUpdateComment: mutation,
    onUpdateGeneralComment: mutation,
  });

  expect(capabilities).toMatchObject({
    authoring: { canCreateInline: false },
    general: {},
    inline: {},
    onSignIn,
  });
});

test('supplies the share destination for every shared walkthrough source', async () => {
  const sources = [
    { type: 'working-tree' },
    { sha: 'a'.repeat(40) as GitSha, type: 'commit' },
    {
      baseSha: 'b'.repeat(40) as GitSha,
      headSha: 'c'.repeat(40) as GitSha,
      ref: 'main...feature',
      type: 'branch-diff',
    },
    { base: 'main', head: 'feature', symmetric: true, type: 'range' },
    {
      number: 7,
      owner: 'cloudflare',
      provider: 'github',
      repo: 'codiff',
      type: 'pull-request',
      url: 'https://github.com/cloudflare/codiff/pull/7',
    },
    {
      number: 8,
      projectPath: 'cloudflare/codiff',
      provider: 'gitlab',
      type: 'pull-request',
      url: 'https://gitlab.example.com/cloudflare/codiff/-/merge_requests/8',
    },
  ] satisfies ReadonlyArray<ResolvedReviewSource>;
  const commenting = {
    canComment: true,
    onSubmitComment: async () => {
      throw new Error('Not submitted by this test.');
    },
  };

  for (const source of sources) {
    const snapshot = {
      branch: 'main',
      codiffVersion: 'test',
      exportedAt: '2026-08-06T00:00:00.000Z',
      files: [],
      kind: 'codiff-walkthrough-share',
      preferences: {
        codeFontFamily: 'Fira Code',
        codeFontSize: 13,
        diffStyle: 'split',
        showWhitespace: false,
        theme: 'system',
        wordWrap: false,
      },
      repository: { root: '/repo', source },
      version: 1,
      walkthrough: {
        agent: 'codex',
        chapters: [],
        focus: 'Review share comment capabilities.',
        generatedAt: '2026-08-06T00:00:00.000Z',
        kind: 'narrative',
        repo: { branch: 'main', root: '/repo' },
        source,
        support: [],
        title: 'Shared review',
        version: 4,
      },
    } satisfies SharedWalkthroughSnapshot;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(SharedWalkthroughApp, {
          commenting,
          providerLabel: 'GitHub',
          snapshot,
        }),
      );
    });
    expect(
      Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim()),
    ).toContain('Comments');
    expect(container.querySelector('button[aria-label="Copy Review Notes"]')).toBeNull();
    await act(async () => root.unmount());
    container.remove();
  }
});
