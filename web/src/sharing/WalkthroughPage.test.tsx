// @vitest-environment jsdom

import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

const fate = vi.hoisted(() => ({
  client: {
    mutations: {
      shareComment: {
        createThread: vi.fn(),
        deleteMessage: vi.fn(),
        reply: vi.fn(),
        resolveThread: vi.fn(),
        updateMessage: vi.fn(),
      },
      walkthrough: { delete: vi.fn() },
    },
  },
  useFateClient: vi.fn(),
  useLiveView: vi.fn(),
  useRequest: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  signIn: { social: vi.fn() },
  useSession: vi.fn(),
}));
const rendered = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));
const shareThreads = vi.hoisted(() => ({
  threads: [] as Array<unknown>,
}));

vi.mock('@nkzw/codiff-service/react', () => ({
  resolveSubmittedShareReply: vi.fn(),
  resolveSubmittedShareThread: vi.fn(),
  SharedWalkthroughApp: (props: Record<string, unknown>) => {
    rendered.props = props;
    return <div>Walkthrough</div>;
  },
}));
vi.mock('react-fate', () => ({
  useFateClient: fate.useFateClient,
  useLiveView: fate.useLiveView,
  useRequest: fate.useRequest,
  view: () => (selection: unknown) => selection,
}));
vi.mock('void/client/react', () => ({ auth }));
vi.mock('./ShareComments.tsx', () => ({
  ShareCommentMessageView: {},
  ShareComments: ({ children }: { children: (threads: Array<unknown>) => unknown }) =>
    children(shareThreads.threads),
  ShareCommentThreadConnectionView: { items: { node: {} } },
  ShareCommentThreadView: {},
}));

import WalkthroughPage from './WalkthroughPage.tsx';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  rendered.props = null;
  shareThreads.threads = [];
  fate.useFateClient.mockReset().mockReturnValue(fate.client);
  fate.useRequest.mockReset().mockReturnValue({
    walkthroughBySlug: { __typename: 'Walkthrough', id: 'walkthrough-id' },
  });
  fate.useLiveView.mockReset().mockReturnValue({
    canDelete: false,
    canResolveComments: true,
    commentThreads: {},
    id: 'walkthrough-id',
    slug: 'optimistic-walkthrough',
  });
  for (const mutation of Object.values(fate.client.mutations.shareComment)) {
    mutation.mockReset().mockResolvedValue({ error: null });
  }
  auth.useSession.mockReset().mockReturnValue({
    data: {
      user: {
        displayUsername: 'ada',
        email: 'ada@example.com',
        id: 'user-id',
        image: 'https://example.com/ada.png',
        name: 'Ada Lovelace',
      },
    },
    isPending: false,
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      kind: 'codiff-walkthrough-share',
      repository: {},
      version: 1,
      walkthrough: { chapters: [], title: 'Walkthrough' },
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

test('optimistically adds walkthrough-level comments and replies', async () => {
  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <WalkthroughPage slug="optimistic-walkthrough" />
      </Suspense>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const commenting = rendered.props?.commenting as {
    onReplyGeneralComment(threadId: string, body: string): Promise<void>;
    onSubmitGeneralComment(body: string): Promise<void>;
  };
  await commenting.onSubmitGeneralComment('An immediate top-level comment.');
  await commenting.onReplyGeneralComment('thread-id', 'An immediate reply.');

  expect(fate.client.mutations.shareComment.createThread).toHaveBeenCalledWith({
    input: {
      body: 'An immediate top-level comment.',
      shareId: 'walkthrough-id',
      shareType: 'walkthrough',
      target: { kind: 'walkthrough-general' },
    },
    optimistic: {
      anchorJson: null,
      createdAt: expect.any(Date),
      filePath: null,
      id: expect.stringMatching(/^optimistic:/),
      kind: 'walkthrough-general',
      lineNumber: null,
      messages: [
        {
          authorImage: 'https://example.com/ada.png',
          authorName: 'Ada Lovelace',
          authorUsername: 'ada',
          body: 'An immediate top-level comment.',
          canEdit: true,
          createdAt: expect.any(Date),
          id: expect.stringMatching(/^optimistic:/),
          threadId: expect.stringMatching(/^optimistic:/),
          updatedAt: expect.any(Date),
        },
      ],
      planId: null,
      resolvedAt: null,
      side: null,
      startLineNumber: null,
      startSide: null,
      status: 'open',
      updatedAt: expect.any(Date),
      walkthroughId: 'walkthrough-id',
    },
    view: {},
  });
  expect(fate.client.mutations.shareComment.reply).toHaveBeenCalledWith({
    input: { body: 'An immediate reply.', threadId: 'thread-id' },
    optimistic: {
      authorImage: 'https://example.com/ada.png',
      authorName: 'Ada Lovelace',
      authorUsername: 'ada',
      body: 'An immediate reply.',
      canEdit: true,
      createdAt: expect.any(Date),
      id: expect.stringMatching(/^optimistic:/),
      threadId: 'thread-id',
      updatedAt: expect.any(Date),
    },
    view: {},
  });
});

test('persists an unpositioned diff comment with its legacy section ID', async () => {
  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <WalkthroughPage slug="optimistic-walkthrough" />
      </Suspense>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const commenting = rendered.props?.commenting as {
    onSubmitComment(comment: {
      body: string;
      filePath: string;
      lineNumber: number;
      sectionId: string;
      side: 'additions';
    }): Promise<unknown>;
  };
  await commenting.onSubmitComment({
    body: 'Review this line.',
    filePath: 'src/review.ts',
    lineNumber: 12,
    sectionId: 'src/review.ts:commit:second',
    side: 'additions',
  });

  expect(fate.client.mutations.shareComment.createThread).toHaveBeenCalledWith(
    expect.objectContaining({
      input: {
        body: 'Review this line.',
        shareId: 'walkthrough-id',
        shareType: 'walkthrough',
        target: {
          filePath: 'src/review.ts',
          kind: 'walkthrough-diff',
          lineNumber: 12,
          sectionId: 'src/review.ts:commit:second',
          side: 'additions',
        },
      },
      optimistic: expect.objectContaining({
        filePath: 'src/review.ts',
        kind: 'walkthrough-diff',
        lineNumber: 12,
        positionJson: null,
        sectionId: 'src/review.ts:commit:second',
        side: 'additions',
      }),
      view: {},
    }),
  );
});

test('persists a positioned diff comment without its legacy section ID', async () => {
  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <WalkthroughPage slug="optimistic-walkthrough" />
      </Suspense>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const position = {
    range: {
      base: {
        kind: 'commit' as const,
        label: { kind: 'commit' as const, text: 'a' },
        sha: 'a'.repeat(40),
      },
      head: {
        kind: 'commit' as const,
        label: { kind: 'commit' as const, text: 'b' },
        sha: 'b'.repeat(40),
      },
    },
  };
  const commenting = rendered.props?.commenting as {
    onSubmitComment(comment: {
      body: string;
      filePath: string;
      lineNumber: number;
      position: typeof position;
      sectionId: string;
      side: 'additions';
    }): Promise<unknown>;
  };
  await commenting.onSubmitComment({
    body: 'Review this durable position.',
    filePath: 'src/review.ts',
    lineNumber: 12,
    position,
    sectionId: 'src/review.ts:commit:second',
    side: 'additions',
  });

  expect(fate.client.mutations.shareComment.createThread).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        target: {
          filePath: 'src/review.ts',
          kind: 'walkthrough-diff',
          lineNumber: 12,
          position,
          side: 'additions',
        },
      }),
      optimistic: expect.objectContaining({
        positionJson: JSON.stringify(position),
        sectionId: null,
      }),
    }),
  );
  const request = fate.client.mutations.shareComment.createThread.mock.calls[0]![0];
  expect(request.input.target).not.toHaveProperty('sectionId');
});

test('loads durable positions before falling back to legacy section IDs', async () => {
  shareThreads.threads = [
    {
      filePath: 'src/repeated.ts',
      id: 'legacy-thread',
      kind: 'walkthrough-diff',
      lineNumber: 8,
      messages: [
        {
          authorImage: null,
          authorName: 'Ada Lovelace',
          authorUsername: 'ada',
          body: 'Keep this comment on the second repeated patch.',
          canEdit: false,
          createdAt: new Date('2026-07-22T00:00:00.000Z'),
          id: 'legacy-message',
          threadId: 'legacy-thread',
          updatedAt: new Date('2026-07-22T00:00:00.000Z'),
        },
      ],
      positionJson: null,
      sectionId: 'src/repeated.ts:commit:second',
      side: 'additions',
      startLineNumber: null,
      startSide: null,
      status: 'open',
    },
    {
      filePath: 'src/repeated.ts',
      id: 'durable-thread',
      kind: 'walkthrough-diff',
      lineNumber: 8,
      messages: [
        {
          authorImage: null,
          authorName: 'Ada Lovelace',
          authorUsername: 'ada',
          body: 'Use the durable range instead.',
          canEdit: false,
          createdAt: new Date('2026-07-22T00:00:00.000Z'),
          id: 'durable-message',
          threadId: 'durable-thread',
          updatedAt: new Date('2026-07-22T00:00:00.000Z'),
        },
      ],
      positionJson: JSON.stringify({
        range: {
          base: { kind: 'commit', label: { kind: 'commit', text: 'a' }, sha: 'a'.repeat(40) },
          head: { kind: 'commit', label: { kind: 'commit', text: 'b' }, sha: 'b'.repeat(40) },
        },
      }),
      sectionId: 'src/repeated.ts:commit:first',
      side: 'additions',
      startLineNumber: null,
      startSide: null,
      status: 'open',
    },
  ];

  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <WalkthroughPage slug="legacy-section-comment" />
      </Suspense>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const reviewComments = (
    rendered.props!.snapshot as { reviewComments: Array<Record<string, unknown>> }
  ).reviewComments;
  expect(reviewComments.find((comment) => comment.id === 'legacy-message')).toMatchObject({
    sectionId: 'src/repeated.ts:commit:second',
  });
  expect(reviewComments.find((comment) => comment.id === 'durable-message')).toMatchObject({
    position: expect.any(Object),
  });
  expect(reviewComments.find((comment) => comment.id === 'durable-message')).not.toHaveProperty(
    'sectionId',
  );
});
