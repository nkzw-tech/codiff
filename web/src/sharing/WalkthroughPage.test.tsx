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
  ShareComments: ({ children }: { children: (threads: []) => unknown }) => children([]),
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
  window.localStorage.clear();
  rendered.props = null;
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

test('passes device-local review preferences and settings to the public viewer', async () => {
  window.localStorage.setItem(
    'codiff:web-review-preferences:v1',
    JSON.stringify({
      codeFontFamily: 'JetBrains Mono',
      codeFontSize: 15,
      diffStyle: 'unified',
      showWhitespace: true,
      theme: 'dark',
      wordWrap: true,
    }),
  );

  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <WalkthroughPage slug="optimistic-walkthrough" />
      </Suspense>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(rendered.props?.settingsBar).toBeTruthy();
  const snapshot = rendered.props?.snapshot as { preferences?: unknown } | undefined;
  expect(snapshot?.preferences).toEqual({
    codeFontFamily: 'JetBrains Mono',
    codeFontSize: 15,
    diffStyle: 'unified',
    showWhitespace: true,
    theme: 'dark',
    wordWrap: true,
  });
});

test('preserves snapshot defaults for missing device-local preferences', async () => {
  fate.useLiveView.mockReturnValue({
    canDelete: false,
    canResolveComments: true,
    commentThreads: {},
    id: 'walkthrough-id',
    slug: 'fallback-walkthrough',
  });
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    Response.json({
      kind: 'codiff-walkthrough-share',
      preferences: {
        codeFontFamily: 'Fira Code',
        codeFontSize: 18,
        diffStyle: 'split',
        showWhitespace: true,
        theme: 'light',
        wordWrap: true,
      },
      repository: {},
      version: 1,
      walkthrough: { chapters: [], title: 'Walkthrough' },
    }),
  );
  window.localStorage.setItem(
    'codiff:web-review-preferences:v1',
    JSON.stringify({ codeFontFamily: 'JetBrains Mono' }),
  );

  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <WalkthroughPage slug="fallback-walkthrough" />
      </Suspense>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const snapshot = rendered.props?.snapshot as { preferences?: unknown } | undefined;
  expect(snapshot?.preferences).toEqual({
    codeFontFamily: 'JetBrains Mono',
    codeFontSize: 18,
    diffStyle: 'split',
    showWhitespace: true,
    theme: 'light',
    wordWrap: true,
  });
});
