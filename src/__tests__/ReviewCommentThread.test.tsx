/**
 * @vitest-environment jsdom
 */

import type { DiffLineAnnotation } from '@pierre/diffs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { ReviewCommentThread } from '../app/components/ReviewCommentThread.tsx';
import { defaultKeymap } from '../config/defaults.ts';
import type { ReviewComment, ReviewCommentAnnotationMetadata } from '../lib/app-types.ts';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const comment = {
  body: '',
  filePath: 'src/App.tsx',
  id: 'comment-1',
  isReadOnly: false,
  lineNumber: 4,
  sectionId: 'src/App.tsx:unstaged',
  side: 'additions',
} satisfies ReviewComment;

const annotation = {
  lineNumber: 4,
  metadata: {
    commentIds: [comment.id],
    type: 'review-comment',
  },
  side: 'additions',
} satisfies DiffLineAnnotation<ReviewCommentAnnotationMetadata>;

const renderThread = ({
  isPullRequest = false,
  onAskCodex = vi.fn(),
  onSubmitComment = vi.fn(),
  onUpdateComment = vi.fn(),
}: {
  isPullRequest?: boolean;
  onAskCodex?: (commentId: string, body: string) => void;
  onSubmitComment?: (commentId: string, body: string) => void;
  onUpdateComment?: (commentId: string, body: string) => void;
} = {}) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <ReviewCommentThread
        agentId="codex"
        agentLabel="Codex"
        annotation={annotation}
        comments={[comment]}
        focusCommentId={null}
        focusCommentRequest={0}
        identity={null}
        isPullRequest={isPullRequest}
        keymap={defaultKeymap}
        onAskCodex={onAskCodex}
        onCommentBlur={() => {}}
        onCommentFocus={() => {}}
        onDeleteComment={() => {}}
        onSubmitComment={onSubmitComment}
        onUpdateComment={onUpdateComment}
      />,
    );
  });

  return { container, root };
};

const changeTextarea = (textarea: HTMLTextAreaElement, value: string) => {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const getTextarea = (container: HTMLElement) => {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) {
    throw new Error('Expected comment textarea to render.');
  }
  return textarea;
};

const getButtonByText = (container: HTMLElement, text: string) => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === text,
  );
  if (!button) {
    throw new Error(`Expected ${text} button to render.`);
  }
  return button;
};

const clickActionButtonFromTextarea = (
  textarea: HTMLTextAreaElement,
  button: HTMLButtonElement,
) => {
  act(() => {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    button.click();
  });
};

const cleanup = async (root: Root, container: HTMLElement) => {
  await act(async () => root.unmount());
  container.remove();
};

test('keeps comment typing local until blur', async () => {
  const onUpdateComment = vi.fn();
  const { container, root } = renderThread({ onUpdateComment });

  try {
    const textarea = getTextarea(container);

    changeTextarea(textarea, 'draft body');

    expect(onUpdateComment).not.toHaveBeenCalled();

    act(() => {
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(onUpdateComment).toHaveBeenCalledWith(comment.id, 'draft body');
  } finally {
    await cleanup(root, container);
  }
});

test('passes the latest local draft to Ask when blur commits first', async () => {
  const onAskCodex = vi.fn();
  const onUpdateComment = vi.fn();
  const { container, root } = renderThread({ onAskCodex, onUpdateComment });

  try {
    const textarea = getTextarea(container);

    changeTextarea(textarea, 'ask this');

    const askButton = getButtonByText(container, 'Ask');

    clickActionButtonFromTextarea(textarea, askButton);

    expect(onUpdateComment).toHaveBeenCalledWith(comment.id, 'ask this');
    expect(onAskCodex).toHaveBeenCalledWith(comment.id, 'ask this');
  } finally {
    await cleanup(root, container);
  }
});

test('passes the latest local draft to pull request Comment when blur commits first', async () => {
  const onSubmitComment = vi.fn();
  const onUpdateComment = vi.fn();
  const { container, root } = renderThread({
    isPullRequest: true,
    onSubmitComment,
    onUpdateComment,
  });

  try {
    const textarea = getTextarea(container);

    changeTextarea(textarea, 'submit this');

    const commentButton = getButtonByText(container, 'Comment');

    clickActionButtonFromTextarea(textarea, commentButton);

    expect(onUpdateComment).toHaveBeenCalledWith(comment.id, 'submit this');
    expect(onSubmitComment).toHaveBeenCalledWith(comment.id, 'submit this');
  } finally {
    await cleanup(root, container);
  }
});
