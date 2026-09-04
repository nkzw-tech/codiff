import type { ShareCommentMessage, ShareCommentThread } from '@nkzw/codiff-service/views';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { type ConnectionRef, type ViewRef, useLiveListView, useLiveView, view } from 'react-fate';

export const ShareCommentMessageView = view<ShareCommentMessage>()({
  authorImage: true,
  authorName: true,
  authorUsername: true,
  body: true,
  canEdit: true,
  createdAt: true,
  id: true,
  threadId: true,
  updatedAt: true,
});

export const ShareCommentMessageConnectionView = {
  items: { node: ShareCommentMessageView },
  live: { append: 'visible' as const },
};

export const ShareCommentThreadView = view<ShareCommentThread>()({
  anchorJson: true,
  createdAt: true,
  filePath: true,
  id: true,
  kind: true,
  lineNumber: true,
  messages: ShareCommentMessageConnectionView,
  planId: true,
  positionJson: true,
  resolvedAt: true,
  sectionId: true,
  side: true,
  startLineNumber: true,
  startSide: true,
  status: true,
  updatedAt: true,
  walkthroughId: true,
});

export const ShareCommentThreadConnectionView = {
  items: { node: ShareCommentThreadView },
  live: { append: 'visible' as const },
};

export type ShareCommentMessageValue = ShareCommentMessage;
export type ShareCommentThreadValue = Omit<ShareCommentThread, 'messages'> & {
  messages: ReadonlyArray<ShareCommentMessageValue>;
};

const MessageBridge = ({
  message: messageRef,
  onChange,
}: {
  message: ViewRef<'ShareCommentMessage'>;
  onChange: (message: ShareCommentMessageValue) => void;
}) => {
  const message = useLiveView(ShareCommentMessageView, messageRef);
  useEffect(() => onChange(message), [message, onChange]);
  return null;
};

const ThreadBridge = ({
  onChange,
  thread: threadRef,
}: {
  onChange: (thread: ShareCommentThreadValue) => void;
  thread: ViewRef<'ShareCommentThread'>;
}) => {
  const thread = useLiveView(ShareCommentThreadView, threadRef);
  const [messageItems] = useLiveListView(ShareCommentMessageConnectionView, thread.messages);
  const [messages, setMessages] = useState(() => new Map<string, ShareCommentMessageValue>());

  useEffect(() => {
    const ordered = messageItems.flatMap(({ node }) => {
      const message = messages.get(String(node.id));
      return message ? [message] : [];
    });
    if (ordered.length === messageItems.length) {
      onChange({ ...thread, messages: ordered });
    }
  }, [messageItems, messages, onChange, thread]);

  const handleMessageChange = useCallback((message: ShareCommentMessageValue) => {
    setMessages((current) => {
      const next = new Map(current);
      next.set(message.id, message);
      return next;
    });
  }, []);

  return messageItems.map(({ node }) => (
    <MessageBridge key={node.id} message={node} onChange={handleMessageChange} />
  ));
};

export const ShareComments = ({
  children,
  connection,
}: {
  children: (threads: ReadonlyArray<ShareCommentThreadValue>) => ReactNode;
  connection: ConnectionRef<'ShareCommentThread'>;
}) => {
  const [threadItems] = useLiveListView(ShareCommentThreadConnectionView, connection);
  const [threads, setThreads] = useState(() => new Map<string, ShareCommentThreadValue>());
  const ordered = threadItems.flatMap(({ node }) => {
    const thread = threads.get(String(node.id));
    return thread ? [thread] : [];
  });
  const handleThreadChange = useCallback((thread: ShareCommentThreadValue) => {
    setThreads((current) => {
      const next = new Map(current);
      next.set(thread.id, thread);
      return next;
    });
  }, []);

  return (
    <>
      {children(ordered)}
      {threadItems.map(({ node }) => (
        <ThreadBridge key={node.id} onChange={handleThreadChange} thread={node} />
      ))}
    </>
  );
};
