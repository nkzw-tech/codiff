import {
  MarkdownEditor,
  type MarkdownAnnotation,
  type MarkdownAnnotationLayout,
  type MarkdownCommentTarget,
  type MarkdownEditorHandle,
} from '@nkzw/mdx-editor';
import { ShareNetworkIcon as ShareNetwork } from '@phosphor-icons/react/ShareNetwork';
import { XIcon as X } from '@phosphor-icons/react/X';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { flushSync } from 'react-dom';
import type {
  CodiffMarkdownDocument,
  GitIdentity,
  PlanCommentAuthor,
  PlanCommentThread,
  PlanHandoffStatus,
  PlanReview,
} from '../../types.ts';
import { Avatar } from './Avatar.tsx';
import { Button } from './Button.tsx';
import {
  MarkdownDocumentEditor,
  type MarkdownDocumentEditorHandle,
} from './MarkdownDocumentEditor.tsx';

const saveDebounceMs = 50;

const createEmptyReview = (document: CodiffMarkdownDocument): PlanReview => ({
  document: {
    id: document.id,
    path: document.path,
    version: document.version,
  },
  threads: [],
  version: 1,
});

const getAuthor = (identity: GitIdentity | null): PlanCommentAuthor => {
  const name = identity?.name || identity?.email || 'You';
  return {
    ...(identity?.email ? { email: identity.email } : {}),
    ...(identity?.gravatarUrl ? { avatarUrl: identity.gravatarUrl } : {}),
    ...(identity?.username ? { username: identity.username } : {}),
    id: identity?.email || 'local-user',
    name,
  };
};

const getThreadBody = (thread: PlanCommentThread) => thread.messages[0]?.body ?? '';

const hasThreadContent = (thread: PlanCommentThread) =>
  thread.messages.some((message) => message.body.trim().length > 0);

const planCommentEntityLabels: Readonly<Record<string, string>> = {
  codeblock: 'Code block',
  frontmatter: 'Frontmatter',
  heading: 'Heading',
  horizontalrule: 'Divider',
  image: 'Image',
  listitem: 'List item',
  paragraph: 'Paragraph',
  quote: 'Quote',
  table: 'Table',
};

const getPlanCommentEntityLabel = (thread: PlanCommentThread) =>
  thread.anchor.kind === 'text'
    ? 'Selection'
    : (planCommentEntityLabels[thread.anchor.block.type] ?? 'Block');

const getPlanCommentTargetLabel = (thread: PlanCommentThread) => {
  const entity = getPlanCommentEntityLabel(thread);
  const targetText = (
    thread.anchor.kind === 'text' ? thread.anchor.quote?.exact : thread.anchor.block.text
  )
    ?.replaceAll(/\s+/g, ' ')
    .trim();
  if (!targetText) {
    return entity;
  }
  const maximumLength = 48;
  const excerpt =
    targetText.length > maximumLength
      ? `${targetText.slice(0, maximumLength - 1).trimEnd()}…`
      : targetText;
  return `${entity} · ${excerpt}`;
};

export function PlanCommentCard({
  active,
  detached,
  onActivate,
  onBodyChange,
  onDelete,
  onEmptyBlur,
  onHeightChange,
  onReveal,
  readOnly,
  showDelete,
  thread,
}: {
  active: boolean;
  detached: boolean;
  onActivate: () => void;
  onBodyChange: (body: string) => void;
  onDelete: () => void;
  onEmptyBlur: () => void;
  onHeightChange: () => void;
  onReveal: () => void;
  readOnly: boolean;
  showDelete: boolean;
  thread: PlanCommentThread;
}) {
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const body = getThreadBody(thread);
  const author = thread.createdBy;
  const displayName = author.name || 'Unknown author';
  const resolved = thread.status === 'resolved';
  const resolutionLabel =
    thread.resolution?.reason === 'agent-handled'
      ? 'Resolved by agent'
      : thread.resolution?.reason === 'anchor-removed'
        ? 'Resolved after target removal'
        : 'Resolved';

  useEffect(() => {
    if (active && body.length === 0) {
      editorRef.current?.focus({ preventScroll: true });
    }
  }, [active, body.length]);

  return (
    <div
      className={`review-comment-thread plan-comment-thread${active ? ' active' : ''}${
        detached ? ' detached' : ''
      }${resolved ? ' resolved' : ''}`}
      onFocusCapture={onActivate}
      onPointerDown={onActivate}
    >
      <div className="review-comment">
        <Avatar name={displayName} size="medium" url={author.avatarUrl} />
        <div className="review-comment-body">
          <div className="review-comment-header plan-comment-header">
            <div className="plan-comment-heading">
              <strong>{displayName}</strong>
              {resolved ? <span className="plan-comment-status">{resolutionLabel}</span> : null}
              <button
                aria-label={`Show comment target: ${getPlanCommentTargetLabel(thread)}`}
                className="plan-comment-target"
                disabled={detached || resolved}
                onClick={onReveal}
                title={
                  detached || resolved
                    ? `Comment target unavailable: ${getPlanCommentTargetLabel(thread)}`
                    : `Show ${getPlanCommentTargetLabel(thread)}`
                }
                type="button"
              >
                {getPlanCommentTargetLabel(thread)}
              </button>
            </div>
            {showDelete ? (
              <button
                aria-label="Delete comment"
                className="review-comment-delete"
                disabled={readOnly}
                onClick={onDelete}
                title="Delete comment"
                type="button"
              >
                <X aria-hidden className="review-comment-delete-icon" size={14} weight="bold" />
              </button>
            ) : null}
          </div>
          <MarkdownEditor
            ariaLabel="Edit plan comment"
            className="review-comment-markdown-editor"
            colorScheme="inherit"
            contentClassName="review-comment-input"
            density="compact"
            onBlur={() => {
              if (!body.trim()) {
                onEmptyBlur();
              }
            }}
            onChange={onBodyChange}
            onHeightChange={onHeightChange}
            onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
              if (event.key === 'Escape' && !body.trim()) {
                event.preventDefault();
                onDelete();
              }
            }}
            placeholder="Write a comment…"
            readOnly={readOnly || resolved}
            ref={editorRef}
            spellCheck
            suppressHtmlProcessing={readOnly || resolved}
            value={body}
            variant="embedded"
          />
        </div>
      </div>
    </div>
  );
}

function PlanCommentRail({
  activeThreadId,
  layoutPass,
  layouts,
  onActivate,
  onBodyChange,
  onDelete,
  onEmptyBlur,
  onHeightChange,
  onReveal,
  readOnly,
  showDelete = true,
  threads,
  workspace,
}: {
  activeThreadId: string | null;
  layoutPass: number;
  layouts: ReadonlyArray<MarkdownAnnotationLayout>;
  onActivate: (thread: PlanCommentThread) => void;
  onBodyChange: (threadId: string, body: string) => void;
  onDelete: (threadId: string) => void;
  onEmptyBlur: (threadId: string) => void;
  onHeightChange: () => void;
  onReveal: (thread: PlanCommentThread) => void;
  readOnly: boolean;
  showDelete?: boolean;
  threads: ReadonlyArray<PlanCommentThread>;
  workspace: HTMLElement | null;
}) {
  const asideRef = useRef<HTMLElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const railRef = useRef<HTMLDivElement>(null);
  const resolvedRef = useRef<HTMLDetailsElement>(null);
  const layoutById = useMemo(
    () => new Map(layouts.map((layout) => [layout.id, layout])),
    [layouts],
  );
  const openThreads = useMemo(
    () =>
      threads
        .filter((thread) => thread.status === 'open')
        .sort((left, right) => {
          const leftTop = layoutById.get(left.id)?.rect?.top ?? Number.POSITIVE_INFINITY;
          const rightTop = layoutById.get(right.id)?.rect?.top ?? Number.POSITIVE_INFINITY;
          return leftTop - rightTop || left.createdAt.localeCompare(right.createdAt);
        }),
    [layoutById, threads],
  );
  const resolvedThreads = useMemo(
    () =>
      threads
        .filter((thread) => thread.status === 'resolved')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [threads],
  );

  useLayoutEffect(() => {
    if (!workspace) {
      return;
    }
    const workspaceTop = workspace.getBoundingClientRect().top;
    let bottom = 12;
    for (const thread of openThreads) {
      const layout = layoutById.get(thread.id);
      const card = cardRefs.current.get(thread.id);
      if (!card) {
        continue;
      }
      if (!layout) {
        card.style.visibility = 'hidden';
        continue;
      }
      card.style.visibility = '';
      const preferredTop = layout.rect ? layout.rect.top - workspaceTop : bottom;
      const top = Math.max(preferredTop, bottom);
      card.style.top = `${top}px`;
      const height = card.getBoundingClientRect().height || 110;
      bottom = top + height + 8;
    }
    asideRef.current?.style.setProperty('--plan-comment-resolved-top', `${bottom}px`);
    const resolvedHeight = resolvedRef.current?.getBoundingClientRect().height ?? 0;
    asideRef.current?.style.setProperty(
      '--plan-comment-rail-min-height',
      `${bottom + resolvedHeight + 12}px`,
    );
  }, [layoutById, layoutPass, openThreads, resolvedThreads.length, workspace]);

  useEffect(() => {
    const rail = railRef.current;
    const card = activeThreadId ? cardRefs.current.get(activeThreadId) : null;
    if (!rail || !card || window.getComputedStyle(rail).overflowY !== 'auto') {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const railRect = rail.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const inset = 8;
      let top = rail.scrollTop;
      if (cardRect.top < railRect.top + inset) {
        top += cardRect.top - railRect.top - inset;
      } else if (cardRect.bottom > railRect.bottom - inset) {
        top += cardRect.bottom - railRect.bottom + inset;
      } else {
        return;
      }
      rail.scrollTo({ behavior: 'smooth', top: Math.max(0, top) });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeThreadId]);

  return (
    <aside className="plan-comment-rail" ref={asideRef}>
      <div className="plan-comment-rail-scroll" ref={railRef}>
        {openThreads.map((thread) => {
          const layout = layoutById.get(thread.id);
          return (
            <div
              className="plan-comment-position"
              key={thread.id}
              ref={(element) => {
                if (element) {
                  cardRefs.current.set(thread.id, element);
                } else {
                  cardRefs.current.delete(thread.id);
                }
              }}
            >
              <PlanCommentCard
                active={activeThreadId === thread.id}
                detached={layout?.detached ?? true}
                onActivate={() => onActivate(thread)}
                onBodyChange={(body) => onBodyChange(thread.id, body)}
                onDelete={() => onDelete(thread.id)}
                onEmptyBlur={() => onEmptyBlur(thread.id)}
                onHeightChange={onHeightChange}
                onReveal={() => onReveal(thread)}
                readOnly={readOnly}
                showDelete={showDelete}
                thread={thread}
              />
            </div>
          );
        })}
        {resolvedThreads.length > 0 ? (
          <details className="plan-resolved-comments" onToggle={onHeightChange} ref={resolvedRef}>
            <summary>Resolved comments ({resolvedThreads.length})</summary>
            <div className="plan-resolved-comment-list">
              {resolvedThreads.map((thread) => (
                <PlanCommentCard
                  active={activeThreadId === thread.id}
                  detached
                  key={thread.id}
                  onActivate={() => onActivate(thread)}
                  onBodyChange={(body) => onBodyChange(thread.id, body)}
                  onDelete={() => onDelete(thread.id)}
                  onEmptyBlur={() => onEmptyBlur(thread.id)}
                  onHeightChange={onHeightChange}
                  onReveal={() => onReveal(thread)}
                  readOnly={readOnly}
                  showDelete={showDelete}
                  thread={thread}
                />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </aside>
  );
}

export function PlanEditorView({
  document: initialDocument,
  shareEnabled = false,
}: {
  document: CodiffMarkdownDocument;
  shareEnabled?: boolean;
}) {
  const editorRef = useRef<MarkdownDocumentEditorHandle>(null);
  const completingRef = useRef(false);
  const sharingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<unknown>>(Promise.resolve());
  const reviewRef = useRef<PlanReview | null>(null);
  const initialOpenThreadIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [commentTarget, setCommentTarget] = useState<{
    left: number;
    target: MarkdownCommentTarget;
    top: number;
    width: number;
  } | null>(null);
  const [completing, setCompleting] = useState(false);
  const [document, setDocument] = useState(initialDocument);
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [layouts, setLayouts] = useState<ReadonlyArray<MarkdownAnnotationLayout>>([]);
  const [provisionalLayouts, setProvisionalLayouts] = useState<
    ReadonlyArray<MarkdownAnnotationLayout>
  >([]);
  const [layoutPass, setLayoutPass] = useState(0);
  const [review, setReview] = useState<PlanReview | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [workspace, setWorkspace] = useState<HTMLDivElement | null>(null);
  const pathParts = document.path.split('/');
  const fileName = pathParts.at(-1);

  const persistReview = useCallback((nextReview: PlanReview, immediate: boolean) => {
    reviewRef.current = nextReview;
    setReview(nextReview);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const save = () => {
      savePromiseRef.current = savePromiseRef.current
        .catch(() => {})
        .then(() => window.codiff.savePlanReview(nextReview))
        .then((savedReview) => {
          setSaveError(null);
          return savedReview;
        })
        .catch((error: unknown) => {
          setSaveError(error instanceof Error ? error.message : String(error));
          throw error;
        });
      return savePromiseRef.current;
    };
    if (immediate) {
      void save().catch(() => {});
    } else {
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void save().catch(() => {});
      }, saveDebounceMs);
    }
  }, []);

  useEffect(() => {
    let canceled = false;
    void window.codiff
      .getPlanReview()
      .then((storedReview) => ({ storedReview }))
      .catch((error: unknown) => ({
        loadError: error instanceof Error ? error.message : String(error),
        storedReview: null,
      }))
      .then((reviewResult) => {
        if (canceled) {
          return;
        }
        const { storedReview } = reviewResult;
        const nextReview = storedReview
          ? {
              ...storedReview,
              document: {
                id: initialDocument.id,
                path: initialDocument.path,
                version: initialDocument.version,
              },
            }
          : createEmptyReview(initialDocument);
        initialOpenThreadIdsRef.current = new Set(
          storedReview?.threads
            .filter((thread) => thread.status === 'open')
            .map((thread) => thread.id) ?? [],
        );
        reviewRef.current = nextReview;
        setReview(nextReview);
        if ('loadError' in reviewResult) {
          setSaveError(reviewResult.loadError);
        }
        void window.codiff.markPlanReady();
      });
    void window.codiff.getGitIdentity().then(
      (nextIdentity) => {
        if (!canceled) {
          setIdentity(nextIdentity);
        }
      },
      () => {
        if (!canceled) {
          setIdentity(null);
        }
      },
    );
    return () => {
      canceled = true;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [initialDocument]);

  useEffect(() => {
    const flushReview = () => {
      const current = reviewRef.current;
      if (!current) {
        return;
      }
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      savePromiseRef.current = savePromiseRef.current
        .catch(() => {})
        .then(() => window.codiff.savePlanReview(current));
      void savePromiseRef.current.catch(() => {});
    };
    const handleVisibilityChange = () => {
      if (globalThis.document.visibilityState === 'hidden') {
        flushReview();
      }
    };
    globalThis.document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', flushReview);
    window.addEventListener('pagehide', flushReview);
    return () => {
      globalThis.document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', flushReview);
      window.removeEventListener('pagehide', flushReview);
    };
  }, []);

  const annotations = useMemo<ReadonlyArray<MarkdownAnnotation>>(
    () =>
      review?.threads
        .filter((thread) => thread.status === 'open')
        .map(({ anchor, id }) => ({ anchor, id })) ?? [],
    [review?.threads],
  );
  const effectiveLayouts = useMemo(() => {
    const byId = new Map(layouts.map((layout) => [layout.id, layout]));
    for (const layout of provisionalLayouts) {
      if (!byId.has(layout.id)) {
        byId.set(layout.id, layout);
      }
    }
    return [...byId.values()];
  }, [layouts, provisionalLayouts]);

  const handleAnnotationLayoutChange = useCallback(
    (nextLayouts: ReadonlyArray<MarkdownAnnotationLayout>) => {
      const nextIds = new Set(nextLayouts.map(({ id }) => id));
      setLayouts(nextLayouts);
      setProvisionalLayouts((current) => current.filter(({ id }) => !nextIds.has(id)));
      const initialOpenThreadIds = initialOpenThreadIdsRef.current;
      if (
        initialOpenThreadIds.size > 0 &&
        [...initialOpenThreadIds].every((id) => nextIds.has(id))
      ) {
        initialOpenThreadIdsRef.current = new Set();
        const detachedIds = new Set(
          nextLayouts
            .filter((layout) => layout.detached && initialOpenThreadIds.has(layout.id))
            .map((layout) => layout.id),
        );
        const current = reviewRef.current;
        if (current && detachedIds.size > 0) {
          const resolvedAt = new Date().toISOString();
          persistReview(
            {
              ...current,
              threads: current.threads.map((thread) =>
                detachedIds.has(thread.id) && thread.status === 'open'
                  ? {
                      ...thread,
                      resolution: { reason: 'anchor-removed', resolvedAt },
                      status: 'resolved',
                      updatedAt: resolvedAt,
                    }
                  : thread,
              ),
            },
            true,
          );
          setActiveThreadId((active) => (active && detachedIds.has(active) ? null : active));
        }
      }
    },
    [persistReview],
  );

  const updateThread = useCallback(
    (
      threadId: string,
      update: (thread: PlanCommentThread) => PlanCommentThread,
      immediate = false,
    ) => {
      const current = reviewRef.current;
      if (!current || completingRef.current || sharingRef.current) {
        return;
      }
      persistReview(
        {
          ...current,
          threads: current.threads.map((thread) =>
            thread.id === threadId ? update(thread) : thread,
          ),
        },
        immediate,
      );
    },
    [persistReview],
  );

  const deleteThread = useCallback(
    (threadId: string) => {
      const current = reviewRef.current;
      if (!current || completingRef.current || sharingRef.current) {
        return;
      }
      editorRef.current?.removeAnnotation(threadId);
      const nextReview = {
        ...current,
        threads: current.threads.filter((thread) => thread.id !== threadId),
      };
      persistReview(nextReview, true);
      setProvisionalLayouts((current) => current.filter(({ id }) => id !== threadId));
      setActiveThreadId((active) => (active === threadId ? null : active));
    },
    [persistReview],
  );

  const createComment = useCallback(
    (target?: MarkdownCommentTarget | null) => {
      const current = reviewRef.current;
      if (!current || completingRef.current || sharingRef.current) {
        return;
      }
      const id = crypto.randomUUID();
      const anchor = editorRef.current?.createAnnotation(id, target) ?? null;
      if (!anchor) {
        return;
      }
      if (target) {
        setProvisionalLayouts((current) => [
          ...current.filter((layout) => layout.id !== id),
          {
            detached: false,
            id,
            rect: target.rect,
          },
        ]);
      }
      const author = getAuthor(identity);
      const now = new Date().toISOString();
      const thread: PlanCommentThread = {
        anchor,
        createdAt: now,
        createdBy: author,
        id,
        messages: [
          {
            author,
            body: '',
            createdAt: now,
            id: crypto.randomUUID(),
            updatedAt: now,
          },
        ],
        status: 'open',
        updatedAt: now,
      };
      persistReview({ ...current, threads: [...current.threads, thread] }, true);
      setActiveThreadId(id);
      setCommentTarget(null);
    },
    [identity, persistReview],
  );

  const finalizeReview = useCallback(async () => {
    const saved = await (editorRef.current?.flush() ?? Promise.resolve(true));
    if (!saved) {
      return null;
    }
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = reviewRef.current;
    if (!current) {
      return null;
    }
    const finalThreads = current.threads.filter(hasThreadContent);
    const finalThreadIds = new Set(finalThreads.map((thread) => thread.id));
    for (const thread of current.threads) {
      if (!finalThreadIds.has(thread.id)) {
        editorRef.current?.removeAnnotation(thread.id);
      }
    }
    const finalReview: PlanReview = {
      ...current,
      document: current.document,
      threads: finalThreads.map((thread) => ({
        ...thread,
        anchor: editorRef.current?.getAnnotationAnchor(thread.id) ?? thread.anchor,
      })),
    };
    reviewRef.current = finalReview;
    setReview(finalReview);
    setActiveThreadId((active) => (active && finalThreadIds.has(active) ? active : null));
    await savePromiseRef.current.catch(() => {});
    await window.codiff.savePlanReview(finalReview);
    return finalReview;
  }, []);

  const completePlan = useCallback(
    async (status: PlanHandoffStatus) => {
      if (completingRef.current || sharingRef.current || !reviewRef.current) {
        return;
      }
      completingRef.current = true;
      flushSync(() => {
        setCompleting(true);
        setCommentTarget(null);
      });
      try {
        const finalReview = await finalizeReview();
        if (!finalReview) {
          completingRef.current = false;
          setCompleting(false);
          return;
        }
        await window.codiff.completePlan(finalReview, status);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
        completingRef.current = false;
        setCompleting(false);
      }
    },
    [finalizeReview],
  );

  const sharePlan = useCallback(async () => {
    if (sharingRef.current || completingRef.current || !reviewRef.current) {
      return;
    }
    sharingRef.current = true;
    flushSync(() => {
      setSharing(true);
      setShareCopied(false);
      setCommentTarget(null);
    });
    try {
      const finalReview = await finalizeReview();
      if (!finalReview) {
        return;
      }
      const result = await window.codiff.sharePlan(finalReview);
      if (result.status === 'failed') {
        throw new Error(result.reason);
      }
      setSaveError(null);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      sharingRef.current = false;
      setSharing(false);
    }
  }, [finalizeReview]);

  useEffect(
    () =>
      window.codiff.onPlanCloseRequested(() => {
        void completePlan('closed');
      }),
    [completePlan],
  );

  const handleCommentTargetChange = useCallback(
    (target: MarkdownCommentTarget | null) => {
      if (!target) {
        setCommentTarget(null);
        return;
      }
      if (!workspace) {
        return;
      }
      const workspaceRect = workspace.getBoundingClientRect();
      const contentElement = workspace.querySelector<HTMLElement>('.mdx-editor-content');
      const contentRect = contentElement?.getBoundingClientRect();
      const contentPaddingRight = contentElement
        ? Number.parseFloat(window.getComputedStyle(contentElement).paddingRight) || 0
        : 0;
      const contentRight = contentRect?.right ?? target.rect.left + target.rect.width;
      setCommentTarget({
        left: contentRight - workspaceRect.left - contentPaddingRight,
        target,
        top:
          target.rect.top -
          workspaceRect.top +
          (target.anchor.kind === 'text' ? Math.max(0, (target.rect.height - 24) / 2) : 0),
        width: contentPaddingRight + 24,
      });
    },
    [workspace],
  );

  const activateThread = useCallback((thread: PlanCommentThread) => {
    setActiveThreadId(thread.id);
  }, []);

  const revealThread = useCallback((thread: PlanCommentThread) => {
    setActiveThreadId(thread.id);
    editorRef.current?.focusAnnotation(thread.id);
  }, []);

  const handleDocumentChange = useCallback((nextDocument: CodiffMarkdownDocument) => {
    setDocument(nextDocument);
    const current = reviewRef.current;
    if (current) {
      const nextReview = {
        ...current,
        document: {
          id: nextDocument.id,
          path: nextDocument.path,
          version: nextDocument.version,
        },
      };
      reviewRef.current = nextReview;
      setReview(nextReview);
    }
  }, []);

  if (!review) {
    return <main className="loading">Loading…</main>;
  }

  return (
    <main className="plan-shell">
      <header className="plan-header workspace-top-bar">
        <div className="plan-title" title={document.path}>
          {document.path}
        </div>
      </header>
      <section className="plan-review review">
        {saveError ? (
          <div className="plan-save-error" role="alert">
            {saveError}
          </div>
        ) : null}
        <div
          className={`plan-workspace${review.threads.length > 0 ? ' with-comments' : ''}`}
          onClickCapture={(event) => {
            const element = event.target as HTMLElement;
            const ids =
              element.closest<HTMLElement>('[data-mdx-annotation-ids]')?.dataset.mdxAnnotationIds ??
              element.closest<HTMLElement>('[data-mdx-annotation-block]')?.dataset
                .mdxAnnotationBlock;
            const id = ids?.split(' ')[0];
            if (id) {
              const thread = review.threads.find((candidate) => candidate.id === id);
              if (thread) {
                activateThread(thread);
              }
            }
          }}
          ref={setWorkspace}
        >
          <div
            className="plan-document code-view"
            onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.altKey &&
                event.key.toLowerCase() === 'm'
              ) {
                event.preventDefault();
                createComment(commentTarget?.target);
              }
            }}
          >
            <div className="plan-file-surface">
              <div className="codiff-file-header plan-file-header">
                <div className="codiff-file-heading">
                  <span className="codiff-file-path-row">
                    <span className="codiff-file-path">{fileName}</span>
                  </span>
                </div>
                <div className="plan-actions">
                  {shareEnabled ? (
                    <Button
                      action={sharePlan}
                      className="plan-share-button"
                      disabled={completing || sharing}
                      pendingPlaceholder="Sharing…"
                      title="Share plan"
                      type="button"
                    >
                      <ShareNetwork aria-hidden size={13} />
                      {sharing ? 'Sharing…' : shareCopied ? 'Copied' : 'Share'}
                    </Button>
                  ) : null}
                  <Button
                    action={() => completePlan('done')}
                    className="plan-done-button"
                    disabled={completing || sharing}
                    pendingPlaceholder="Saving…"
                    type="button"
                  >
                    {completing ? 'Saving…' : 'Done'}
                  </Button>
                </div>
              </div>
              <MarkdownDocumentEditor
                activeAnnotationId={activeThreadId}
                annotations={annotations}
                autoFocus
                className="codiff-plan-editor"
                document={document}
                onAnnotationAnchorChange={(id, anchor) => {
                  if (!anchor || completingRef.current || sharingRef.current) {
                    return;
                  }
                  updateThread(
                    id,
                    (thread) => ({
                      ...thread,
                      anchor,
                      updatedAt: new Date().toISOString(),
                    }),
                    false,
                  );
                }}
                onAnnotationLayoutChange={handleAnnotationLayoutChange}
                onCommentTargetChange={handleCommentTargetChange}
                onDocumentChange={handleDocumentChange}
                readOnly={completing || sharing}
                ref={editorRef}
              />
            </div>
          </div>
          {review.threads.length > 0 ? (
            <PlanCommentRail
              activeThreadId={activeThreadId}
              layoutPass={layoutPass}
              layouts={effectiveLayouts}
              onActivate={activateThread}
              onBodyChange={(threadId, body) => {
                updateThread(threadId, (thread) => {
                  const now = new Date().toISOString();
                  return {
                    ...thread,
                    messages: thread.messages.map((message, index) =>
                      index === 0 ? { ...message, body, updatedAt: now } : message,
                    ),
                    updatedAt: now,
                  };
                });
              }}
              onDelete={deleteThread}
              onEmptyBlur={(threadId) => {
                const thread = reviewRef.current?.threads.find(
                  (candidate) => candidate.id === threadId,
                );
                if (thread && !getThreadBody(thread).trim()) {
                  deleteThread(threadId);
                }
              }}
              onHeightChange={() => setLayoutPass((pass) => pass + 1)}
              onReveal={revealThread}
              readOnly={completing || sharing}
              threads={review.threads}
              workspace={workspace}
            />
          ) : null}
          {commentTarget && !completing && !sharing ? (
            <div
              className="plan-comment-affordance"
              data-mdx-comment-button=""
              onPointerLeave={(event) => {
                if (
                  !(event.relatedTarget as HTMLElement | null)?.closest?.(
                    '[data-mdx-comment-block], .mdx-editor-content',
                  )
                ) {
                  handleCommentTargetChange(null);
                }
              }}
              style={
                {
                  '--plan-comment-left': `${commentTarget.left}px`,
                  '--plan-comment-top': `${commentTarget.top}px`,
                  '--plan-comment-width': `${commentTarget.width}px`,
                } as CSSProperties
              }
            >
              <button
                aria-label={`Comment on ${commentTarget.target.label.toLowerCase()}`}
                className="plan-comment-add"
                onClick={() => createComment(commentTarget.target)}
                onPointerDown={(event) => event.preventDefault()}
                title={`Comment on ${commentTarget.target.label.toLowerCase()}`}
                type="button"
              >
                +
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
