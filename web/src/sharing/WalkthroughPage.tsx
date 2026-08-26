import {
  type PullRequestExistingReviewComment,
  type PullRequestGeneralCommentThread,
  type PullRequestReviewComment,
  type SharedWalkthroughSnapshot,
} from '@nkzw/codiff-core';
import {
  resolveSubmittedShareReply,
  resolveSubmittedShareThread,
  SharedWalkthroughApp,
  type SharedWalkthroughCommenting,
} from '@nkzw/codiff-service/react';
import type { Walkthrough } from '@nkzw/codiff-service/views';
import { use } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { type ViewRef, useFateClient, useLiveView, useRequest, view } from 'react-fate';
import { auth } from 'void/client/react';
import { CodiffSettingsBar, useOnlineCodiffPreferences } from '../ReviewSettings.tsx';
import {
  ShareComments,
  ShareCommentMessageView,
  ShareCommentThreadConnectionView,
  ShareCommentThreadView,
  type ShareCommentMessageValue,
  type ShareCommentThreadValue,
} from './ShareComments.tsx';
import {
  errorMessage,
  sessionUsername,
  signInWithGitHub,
  toISOString,
  usePageTitle,
} from './utils.ts';
import ViewerError from './ViewerError.tsx';

const WalkthroughPageView = view<Walkthrough>()({
  canDelete: true,
  canResolveComments: true,
  commentThreads: ShareCommentThreadConnectionView,
  id: true,
  slug: true,
});

const manifests = new Map<string, Promise<SharedWalkthroughSnapshot>>();
const getManifest = (slug: string) => {
  let request = manifests.get(slug);
  if (!request) {
    request = fetch(`/api/walkthroughs/${encodeURIComponent(slug)}/manifest`, {
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Unable to load walkthrough (${response.status}).`);
      }
      return (await response.json()) as SharedWalkthroughSnapshot;
    });
    manifests.set(slug, request);
  }
  return request;
};

const reviewAuthor = (message: ShareCommentMessageValue) => ({
  ...(message.authorImage ? { avatarUrl: message.authorImage } : {}),
  login: message.authorUsername ?? message.authorName,
  name: message.authorName,
});

const reviewComments = (
  threads: ReadonlyArray<ShareCommentThreadValue>,
  signedIn: boolean,
  canResolve: boolean,
): ReadonlyArray<PullRequestExistingReviewComment> =>
  threads.flatMap((thread) => {
    if (thread.kind !== 'walkthrough-diff' || !thread.filePath) {
      return [];
    }
    const fileComment = thread.lineNumber == null && thread.side == null;
    if (!fileComment && (thread.lineNumber == null || thread.side == null)) {
      return [];
    }
    return thread.messages.map((message) => ({
      ...(fileComment
        ? { anchor: 'file' as const }
        : {
            lineNumber: thread.lineNumber!,
            ...(thread.sectionId ? { sectionId: thread.sectionId } : {}),
            side: thread.side!,
            ...(thread.startLineNumber ? { startLineNumber: thread.startLineNumber } : {}),
            ...(thread.startSide ? { startSide: thread.startSide } : {}),
          }),
      author: reviewAuthor(message),
      body: message.body,
      ...(message.canEdit ? { canDelete: true, canEdit: true } : {}),
      ...(signedIn ? {} : { canReplyThread: false }),
      ...(canResolve ? { canResolveThread: true } : {}),
      filePath: thread.filePath!,
      id: message.id,
      ...(thread.status === 'resolved' ? { isThreadResolved: true } : {}),
      submittedAt: toISOString(message.createdAt),
      threadId: thread.id,
    }));
  });

const generalComments = (
  threads: ReadonlyArray<ShareCommentThreadValue>,
  signedIn: boolean,
  canResolve: boolean,
): ReadonlyArray<PullRequestGeneralCommentThread> =>
  threads.flatMap((thread) =>
    thread.kind === 'walkthrough-general'
      ? [
          {
            ...(signedIn ? { canReply: true } : {}),
            ...(canResolve ? { canResolve: true } : {}),
            comments: thread.messages.map((message) => ({
              author: reviewAuthor(message),
              body: message.body,
              ...(message.canEdit ? { canDelete: true, canEdit: true } : {}),
              id: message.id,
              submittedAt: toISOString(message.createdAt),
            })),
            id: thread.id,
            ...(thread.status === 'resolved' ? { isResolved: true } : {}),
          },
        ]
      : [],
  );

const commentTarget = (comment: PullRequestReviewComment) => {
  if (comment.anchor === 'file') {
    return {
      anchor: 'file' as const,
      filePath: comment.filePath,
      kind: 'walkthrough-diff' as const,
    };
  }
  if (comment.lineNumber == null || !comment.side) {
    throw new Error('A walkthrough line comment requires a line number and side.');
  }
  return {
    ...(comment.anchor ? { anchor: comment.anchor } : {}),
    filePath: comment.filePath,
    kind: 'walkthrough-diff' as const,
    lineNumber: comment.lineNumber,
    ...(comment.sectionId ? { sectionId: comment.sectionId } : {}),
    side: comment.side,
    ...(comment.startLineNumber ? { startLineNumber: comment.startLineNumber } : {}),
    ...(comment.startSide ? { startSide: comment.startSide } : {}),
  };
};

const Viewer = ({ walkthrough: walkthroughRef }: { walkthrough: ViewRef<'Walkthrough'> }) => {
  const fate = useFateClient();
  const walkthrough = useLiveView(WalkthroughPageView, walkthroughRef);
  const snapshot = use(getManifest(walkthrough.slug));
  usePageTitle(snapshot.walkthrough.title);
  const [preferences, setPreferences] = useOnlineCodiffPreferences(snapshot.preferences ?? {});
  const { data: session } = auth.useSession();
  const username = sessionUsername(session?.user);
  const deleteShare = walkthrough.canDelete
    ? async () => {
        const response = await fate.mutations.walkthrough.delete({
          input: { id: walkthrough.id },
          view: WalkthroughPageView,
        });
        if (response.error) {
          throw new Error(errorMessage(response.error));
        }
        manifests.delete(walkthrough.slug);
        window.location.replace('/');
      }
    : undefined;
  const deleteComment = async (id: string) => {
    const response = await fate.mutations.shareComment.deleteMessage({
      delete: true,
      input: { id },
      view: ShareCommentMessageView,
    });
    if (response.error) {
      throw new Error(errorMessage(response.error));
    }
  };
  const updateComment = async (messageId: string, body: string) => {
    const response = await fate.mutations.shareComment.updateMessage({
      input: { body, messageId },
      optimistic: { body, id: messageId, updatedAt: new Date() },
      view: ShareCommentMessageView,
    });
    if (response.error) {
      throw new Error(errorMessage(response.error));
    }
  };
  const commenting: SharedWalkthroughCommenting = {
    canComment: Boolean(session?.user.id),
    onDeleteComment: deleteComment,
    onDeleteGeneralComment: deleteComment,
    onReplyGeneralComment: async (threadId, body) => {
      const now = new Date();
      const response = await fate.mutations.shareComment.reply({
        input: { body, threadId },
        optimistic: {
          authorImage: session?.user.image ?? null,
          authorName: session?.user.name ?? 'You',
          authorUsername: username,
          body,
          canEdit: true,
          createdAt: now,
          id: `optimistic:${crypto.randomUUID()}`,
          threadId,
          updatedAt: now,
        },
        view: ShareCommentMessageView,
      });
      if (response.error) {
        throw new Error(errorMessage(response.error));
      }
    },
    onResolveDiscussion: async (threadId, resolved) => {
      const response = await fate.mutations.shareComment.resolveThread({
        input: { resolved, threadId },
        optimistic: {
          id: threadId,
          resolvedAt: resolved ? new Date() : null,
          status: resolved ? 'resolved' : 'open',
          updatedAt: new Date(),
        },
        view: ShareCommentThreadView,
      });
      if (response.error) {
        throw new Error(errorMessage(response.error));
      }
    },
    onSignIn: signInWithGitHub,
    onSubmitComment: async (comment) => {
      const now = new Date();
      if (comment.threadId) {
        const optimisticMessageId = `optimistic:${crypto.randomUUID()}`;
        const response = await fate.mutations.shareComment.reply({
          input: { body: comment.body, threadId: comment.threadId },
          optimistic: {
            authorImage: session?.user.image ?? null,
            authorName: session?.user.name ?? 'You',
            authorUsername: username,
            body: comment.body,
            canEdit: true,
            createdAt: now,
            id: optimisticMessageId,
            threadId: comment.threadId,
            updatedAt: now,
          },
          view: ShareCommentMessageView,
        });
        if (response.error) {
          throw new Error(errorMessage(response.error));
        }
        return resolveSubmittedShareReply({
          canResolveThread: walkthrough.canResolveComments,
          comment: { ...comment, threadId: comment.threadId },
          result: response.result,
        });
      } else {
        const optimisticThreadId = `optimistic:${crypto.randomUUID()}`;
        const target = commentTarget(comment);
        const fileComment = target.anchor === 'file';
        const response = await fate.mutations.shareComment.createThread({
          input: {
            body: comment.body,
            shareId: walkthrough.id,
            shareType: 'walkthrough',
            target,
          },
          optimistic: {
            anchorJson: null,
            createdAt: now,
            filePath: comment.filePath,
            id: optimisticThreadId,
            kind: 'walkthrough-diff',
            lineNumber: fileComment ? null : target.lineNumber,
            messages: [
              {
                authorImage: session?.user.image ?? null,
                authorName: session?.user.name ?? 'You',
                authorUsername: username,
                body: comment.body,
                canEdit: true,
                createdAt: now,
                id: `optimistic:${crypto.randomUUID()}`,
                threadId: optimisticThreadId,
                updatedAt: now,
              },
            ],
            planId: null,
            resolvedAt: null,
            sectionId: fileComment ? null : (target.sectionId ?? null),
            side: fileComment ? null : target.side,
            startLineNumber: fileComment ? null : (target.startLineNumber ?? null),
            startSide: fileComment ? null : (target.startSide ?? null),
            status: 'open',
            updatedAt: now,
            walkthroughId: walkthrough.id,
          },
          view: ShareCommentThreadView,
        });
        if (response.error) {
          throw new Error(errorMessage(response.error));
        }
        return resolveSubmittedShareThread({
          canResolveThread: walkthrough.canResolveComments,
          comment,
          result: response.result,
        });
      }
    },
    onSubmitGeneralComment: async (body) => {
      const now = new Date();
      const optimisticThreadId = `optimistic:${crypto.randomUUID()}`;
      const response = await fate.mutations.shareComment.createThread({
        input: {
          body,
          shareId: walkthrough.id,
          shareType: 'walkthrough',
          target: { kind: 'walkthrough-general' },
        },
        optimistic: {
          anchorJson: null,
          createdAt: now,
          filePath: null,
          id: optimisticThreadId,
          kind: 'walkthrough-general',
          lineNumber: null,
          messages: [
            {
              authorImage: session?.user.image ?? null,
              authorName: session?.user.name ?? 'You',
              authorUsername: username,
              body,
              canEdit: true,
              createdAt: now,
              id: `optimistic:${crypto.randomUUID()}`,
              threadId: optimisticThreadId,
              updatedAt: now,
            },
          ],
          planId: null,
          resolvedAt: null,
          side: null,
          startLineNumber: null,
          startSide: null,
          status: 'open',
          updatedAt: now,
          walkthroughId: walkthrough.id,
        },
        view: ShareCommentThreadView,
      });
      if (response.error) {
        throw new Error(errorMessage(response.error));
      }
    },
    onUpdateComment: updateComment,
    onUpdateGeneralComment: updateComment,
  };

  return (
    <ShareComments connection={walkthrough.commentThreads}>
      {(threads) => (
        <SharedWalkthroughApp
          commenting={commenting}
          gitIdentity={
            session?.user
              ? {
                  email: session.user.email,
                  ...(session.user.image ? { gravatarUrl: session.user.image } : {}),
                  name: session.user.name,
                  ...(username ? { username } : {}),
                }
              : null
          }
          onDeleteShare={deleteShare}
          providerLabel="GitHub"
          settingsBar={
            <CodiffSettingsBar preferences={preferences} setPreferences={setPreferences} />
          }
          snapshot={{
            ...snapshot,
            preferences,
            repository: {
              ...snapshot.repository,
              generalComments: generalComments(
                threads,
                Boolean(session?.user.id),
                walkthrough.canResolveComments,
              ),
            },
            reviewComments: reviewComments(
              threads,
              Boolean(session?.user.id),
              walkthrough.canResolveComments,
            ),
          }}
        />
      )}
    </ShareComments>
  );
};

const Screen = ({ slug }: { slug: string }) => {
  const { walkthroughBySlug } = useRequest({
    walkthroughBySlug: { args: { slug }, view: WalkthroughPageView },
  });
  return walkthroughBySlug ? (
    <Viewer walkthrough={walkthroughBySlug} />
  ) : (
    <ViewerError
      detail={new Error('Unable to load walkthrough (404).')}
      title="Shared walkthrough unavailable"
    />
  );
};

export default function WalkthroughPage({ slug }: { slug: string }) {
  return (
    <ErrorBoundary
      fallbackRender={({ error }) => (
        <ViewerError detail={error} title="Shared walkthrough unavailable" />
      )}
      onError={() => manifests.delete(slug)}
      resetKeys={[slug]}
    >
      <Screen slug={slug} />
    </ErrorBoundary>
  );
}
