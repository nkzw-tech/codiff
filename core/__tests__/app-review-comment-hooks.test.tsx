/**
 * @vitest-environment jsdom
 */

import { act, useRef } from 'react';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { useAppReviewComments } from '../app/hooks/useAppReviewComments.ts';
import type { LocalReviewNote, ProviderCommentDraft } from '../lib/app-types.ts';
import type { RepositoryState } from '../types.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

type AppReviewComments = ReturnType<typeof useAppReviewComments>;

const originalCodiff = window.codiff;
const workingTreeState = {
  branch: 'main',
  files: [],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;
const pullRequestState = {
  ...workingTreeState,
  source: {
    number: 42,
    owner: 'nkzw-tech',
    provider: 'github',
    repo: 'codiff',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/42',
  },
} satisfies RepositoryState;
const localNote: LocalReviewNote = {
  body: 'Review this',
  filePath: 'src/app.ts',
  id: 'comment-1',
  kind: 'local-note',
  lineNumber: 4,
  sectionId: 'src/app.ts:pull-request',
  side: 'additions',
};
const providerDraft: ProviderCommentDraft = {
  body: localNote.body,
  filePath: localNote.filePath,
  id: localNote.id,
  kind: 'provider-draft',
  lineNumber: localNote.lineNumber,
  position: {
    range: {
      base: {
        label: { kind: 'commit', text: 'base' },
        sha: 'a'.repeat(40) as import('../types.ts').GitSha,
      },
      head: {
        label: { kind: 'commit', text: 'head' },
        sha: 'b'.repeat(40) as import('../types.ts').GitSha,
      },
    },
  },
  sectionId: localNote.sectionId,
  side: localNote.side,
};

function AppReviewCommentsHarness({
  onCommentFileChange,
  onState,
  state,
}: {
  onCommentFileChange: (filePath: string) => void;
  onState: (comments: AppReviewComments) => void;
  state: RepositoryState;
}) {
  const stateRef = useRef<RepositoryState | null>(state);
  const comments = useAppReviewComments({
    draftKind: state.source.type === 'pull-request' ? 'provider-draft' : 'local-note',
    isReviewActionDisabled: () => false,
    onCommentFileChange,
    stateRef,
  });
  onState(comments);
  return null;
}

const renderAppReviewComments = async (state: RepositoryState) => {
  const onCommentFileChange = vi.fn();
  const stateRef: { current: AppReviewComments | null } = { current: null };
  const getState = () => {
    if (!stateRef.current) {
      throw new Error('App review comments did not render.');
    }
    return stateRef.current;
  };
  return {
    ...(await renderReact(
      <AppReviewCommentsHarness
        onCommentFileChange={onCommentFileChange}
        onState={(comments) => (stateRef.current = comments)}
        state={state}
      />,
    )),
    getState,
    onCommentFileChange,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  window.codiff = originalCodiff;
});

test('app review comments request and store assistant replies', async () => {
  const askReviewAssistant = vi.fn(async () => ({
    reply: 'Use the shared parser.',
    status: 'ready' as const,
  }));
  window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(workingTreeState);
  const { getState, onCommentFileChange } = view;

  await act(async () => {
    getState().setReviewComments([localNote]);
  });
  await act(async () => {
    getState().askCodex(localNote);
  });
  expect(askReviewAssistant).toHaveBeenCalledWith({
    comment: {
      body: localNote.body,
      filePath: localNote.filePath,
      lineNumber: localNote.lineNumber,
      sectionId: localNote.sectionId,
      side: localNote.side,
    },
    source: workingTreeState.source,
  });
  await waitFor(() => {
    expect(getState().reviewComments[0]?.codexReply).toEqual({
      body: 'Use the shared parser.',
      status: 'ready',
    });
  });
  expect(onCommentFileChange).toHaveBeenCalledTimes(2);
});

test('app review comments submit a draft and replace it with the remote comment', async () => {
  const submitPullRequestComment = vi.fn(async () => ({
    author: {
      login: 'reviewer',
      name: 'Reviewer',
    },
    body: providerDraft.body,
    filePath: providerDraft.filePath,
    id: 'remote-comment',
    lineNumber: providerDraft.lineNumber,
    side: providerDraft.side,
    submittedAt: '2026-07-15T00:00:00.000Z',
    url: 'https://github.com/nkzw-tech/codiff/pull/42#discussion_r1',
  }));
  window.codiff = { submitPullRequestComment } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState, onCommentFileChange } = view;

  await act(async () => {
    getState().setReviewComments([providerDraft]);
  });
  await act(async () => {
    getState().submitPullRequestComment(providerDraft.id);
  });
  expect(submitPullRequestComment).toHaveBeenCalledWith({
    comment: {
      body: providerDraft.body,
      filePath: providerDraft.filePath,
      lineNumber: providerDraft.lineNumber,
      localDraftId: providerDraft.id,
      position: providerDraft.position,
      side: providerDraft.side,
    },
    source: pullRequestState.source,
  });
  await waitFor(() => {
    expect(getState().reviewComments).toEqual([
      {
        author: {
          login: 'reviewer',
          name: 'Reviewer',
        },
        body: providerDraft.body,
        destination: 'provider',
        filePath: providerDraft.filePath,
        id: 'remote-comment',
        isReadOnly: true,
        kind: 'submitted-comment',
        lineNumber: providerDraft.lineNumber,
        position: providerDraft.position,
        resolvedSectionId: providerDraft.sectionId,
        side: providerDraft.side,
        submittedAt: '2026-07-15T00:00:00.000Z',
        url: 'https://github.com/nkzw-tech/codiff/pull/42#discussion_r1',
      },
    ]);
  });
  expect(onCommentFileChange).toHaveBeenCalledTimes(2);
});

test('app review comments submit and clear pending review drafts', async () => {
  const submitPullRequestReview = vi.fn(async () => ({
    status: 'submitted' as const,
    submittedDraftIds: [providerDraft.id],
  }));
  window.codiff = { submitPullRequestReview } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState } = view;

  await act(async () => {
    getState().setReviewComments([providerDraft]);
  });
  await act(async () => {
    await getState().submitPullRequestReview('COMMENT');
  });
  expect(submitPullRequestReview).toHaveBeenCalledWith({
    comments: [
      {
        body: providerDraft.body,
        filePath: providerDraft.filePath,
        lineNumber: providerDraft.lineNumber,
        localDraftId: providerDraft.id,
        position: providerDraft.position,
        side: providerDraft.side,
      },
    ],
    event: 'COMMENT',
    source: pullRequestState.source,
  });
  expect(getState().reviewComments).toEqual([]);
  expect(getState().pullRequestReviewSubmitting).toBeNull();
});

test('synchronous review conversion failure leaves submission controls idle', async () => {
  const invalidDraft = {
    ...providerDraft,
    position: {
      range: {
        base: { kind: 'index', label: { kind: 'review-marker', text: 'Index' } },
        head: {
          kind: 'working-copy',
          label: { kind: 'review-marker', text: 'Working copy' },
        },
      },
    },
  } as unknown as ProviderCommentDraft;
  const submitPullRequestReview = vi.fn(async () => ({
    status: 'submitted' as const,
    submittedDraftIds: [],
  }));
  window.codiff = { submitPullRequestReview } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState } = view;

  await act(async () => getState().setReviewComments([invalidDraft]));
  let thrown: unknown;
  await act(async () => {
    try {
      await getState().submitPullRequestReview('COMMENT');
    } catch (error) {
      thrown = error;
    }
  });

  expect(thrown).toEqual(
    new Error('Provider comments require an exact immutable commit position.'),
  );
  expect(getState().pullRequestReviewSubmitting).toBeNull();
  expect(submitPullRequestReview).not.toHaveBeenCalled();
});

test('synchronous review capability failure clears submission controls', async () => {
  const submitPullRequestReview = vi.fn(() => {
    throw new Error('Provider submission failed synchronously.');
  });
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  window.codiff = { submitPullRequestReview } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState } = view;

  await act(async () => getState().setReviewComments([providerDraft]));
  await act(async () => {
    await expect(getState().submitPullRequestReview('COMMENT')).rejects.toThrow(
      'Provider submission failed synchronously.',
    );
  });

  await waitFor(() => expect(getState().pullRequestReviewSubmitting).toBeNull());
  expect(alert).toHaveBeenCalledWith('Provider submission failed synchronously.');
});

test('outcome-unknown review drafts remain visible and cannot be reposted', async () => {
  const submitPullRequestReview = vi.fn(async () => ({
    outcomeUnknownDraftIds: [providerDraft.id],
    reason: 'Provider outcome is unknown.',
    status: 'failed' as const,
    submittedDraftIds: [],
  }));
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  window.codiff = { submitPullRequestReview } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState } = view;

  await act(async () => getState().setReviewComments([providerDraft]));
  await act(async () => {
    await expect(getState().submitPullRequestReview('COMMENT')).rejects.toThrow(
      'Provider outcome is unknown.',
    );
  });
  await waitFor(() =>
    expect(getState().reviewComments).toEqual([
      expect.objectContaining({
        id: providerDraft.id,
        remoteSubmit: expect.objectContaining({ status: 'outcome-unknown' }),
      }),
    ]),
  );
  await act(async () => getState().submitPullRequestReview('COMMENT'));
  expect(submitPullRequestReview).toHaveBeenCalledOnce();
});

test('partial review submission removes only provider-confirmed drafts', async () => {
  const secondComment = { ...providerDraft, id: 'comment-2', lineNumber: 8 };
  const submitPullRequestReview = vi.fn(async () => ({
    reason: 'The final review action failed.',
    status: 'failed' as const,
    submittedDraftIds: [providerDraft.id],
  }));
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  window.codiff = { submitPullRequestReview } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState } = view;

  await act(async () => {
    getState().setReviewComments([providerDraft, secondComment]);
    getState().updateActiveReviewCommentDraft(secondComment);
  });
  await act(async () => {
    await expect(getState().submitPullRequestReview('COMMENT')).rejects.toThrow(
      'The final review action failed.',
    );
  });
  await waitFor(() => expect(getState().reviewComments).toEqual([secondComment]));
  expect(getState().activeReviewCommentDraftState?.id).toBe(secondComment.id);
  expect(alert).toHaveBeenCalledWith('The final review action failed.');
});
