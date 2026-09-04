/**
 * @vitest-environment jsdom
 */

import { act, useRef } from 'react';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { useAppReviewComments } from '../app/hooks/useAppReviewComments.ts';
import type { LocalReviewNote } from '../lib/app-types.ts';
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
const localNote: LocalReviewNote = {
  body: 'Review this',
  filePath: 'src/app.ts',
  id: 'comment-1',
  kind: 'local-note',
  lineNumber: 4,
  sectionId: 'src/app.ts:pull-request',
  side: 'additions',
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
