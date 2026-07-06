import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ReviewIdentity } from '../../../lib/app-types.ts';
import type { ReviewScrollBehavior } from '../../../lib/app-types.ts';
import {
  buildCommitModel,
  focusChangedFileForHunks,
  formatWalkthroughFileList,
  getUncoveredWalkthroughFiles,
  getWalkthroughRunNote,
  isWalkthroughCommittable,
  resolveWalkthroughHunkRuns,
  walkthroughItemPaths,
  walkthroughItemTitleFallback,
  walkthroughFileName,
  type WalkthroughView,
  type WalkthroughStopView,
} from '../../../lib/narrative-walkthrough.ts';
import type { ChangedFile, NarrativeWalkthrough, WalkthroughHunkGroup } from '../../../types.ts';
import type { ReviewDiffBlock } from '../ReviewCodeView.tsx';
import { CommitView, type CommitHandler, type CommitMessageHandler } from './CommitView.tsx';
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  CaretLeft,
  CaretRight,
  Check,
  GitBranch,
  Path,
  ShareNetwork,
} from './icons.tsx';
import { ChapterIcon, ImportancePill, Narration } from './parts.tsx';
import type { NarrativeNavigation } from './useNarrativeNavigation.ts';

type FocusedRunDiff = {
  file: ChangedFile;
  note?: string;
  reviewIdentity: ReviewIdentity;
};

export type WalkthroughReviewTarget = {
  file: ChangedFile;
  reviewIdentity: ReviewIdentity;
};

export type WalkthroughBlockScrollTarget = {
  behavior?: ReviewScrollBehavior;
  blockId: string;
  request: number;
};

const getFocusedRunDiffs = (
  item: WalkthroughHunkGroup,
  files: ReadonlyArray<ChangedFile>,
): ReadonlyArray<FocusedRunDiff> =>
  resolveWalkthroughHunkRuns(item, files).flatMap((run) => {
    const focused = focusChangedFileForHunks(run.resolved.file, run.resolved.section, run.hunks);
    return focused
      ? [
          {
            file: focused,
            note: getWalkthroughRunNote(item, run),
            reviewIdentity: {
              fingerprint: focused.fingerprint,
              key: `walkthrough:${run.key}`,
            },
          },
        ]
      : [];
  });

export type RenderWalkthroughDiffBlocks = (
  blocks: ReadonlyArray<ReviewDiffBlock>,
  scrollTarget: WalkthroughBlockScrollTarget | null,
  onActiveBlockChange: (blockId: string) => void,
) => ReactNode;

type WalkthroughBlockSet = {
  blocks: ReadonlyArray<ReviewDiffBlock>;
  firstBlockIdByStop: ReadonlyArray<string | null>;
  stopIndexByBlockId: ReadonlyMap<string, number>;
};

type WalkthroughNavigationKeyEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>;

export const getWalkthroughNavigationKeyDirection = (
  event: WalkthroughNavigationKeyEvent,
): -1 | 0 | 1 => {
  const hasAnyModifier = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
  if (!hasAnyModifier) {
    if (event.key === 'j') {
      return 1;
    }
    if (event.key === 'k') {
      return -1;
    }
  }

  const isCtrlOnly = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (isCtrlOnly && event.key === 'ArrowDown') {
    return 1;
  }
  if (isCtrlOnly && event.key === 'ArrowUp') {
    return -1;
  }

  return 0;
};

const emptyWalkthroughBlockSet: WalkthroughBlockSet = {
  blocks: [],
  firstBlockIdByStop: [],
  stopIndexByBlockId: new Map(),
};

function StopHeader({ current, stop }: { current: boolean; stop: WalkthroughStopView }) {
  return (
    <div className={`wt-stop-block wt-stop-block-header${current ? ' current' : ''}`}>
      <div className="wt-stage-title-row">
        <h2 className="wt-stage-title">{stop.title ?? walkthroughItemTitleFallback(stop)}</h2>
        <ImportancePill importance={stop.importance} />
      </div>
      <Narration prose={stop.prose} />
    </div>
  );
}

function SupportHeader({ current }: { current: boolean }) {
  return (
    <div className={`wt-stop-block wt-stop-block-header${current ? ' current' : ''}`}>
      <div className="wt-stage-title-row">
        <h2 className="wt-stage-title">Support</h2>
        <ImportancePill importance="normal" />
      </div>
      <Narration prose="Supporting changes grouped outside the main sequence." />
    </div>
  );
}

function ChangedHeader({
  current,
  onRegenerate,
  regenerateDisabled = false,
}: {
  current: boolean;
  onRegenerate?: () => void;
  regenerateDisabled?: boolean;
}) {
  return (
    <div className={`wt-stop-block wt-stop-block-header${current ? ' current' : ''}`}>
      <div className="wt-stage-title-row">
        <h2 className="wt-stage-title">Changed</h2>
        {onRegenerate ? (
          <button
            className="wt-regenerate"
            disabled={regenerateDisabled}
            onClick={onRegenerate}
            type="button"
          >
            <ArrowsClockwise size={13} weight="bold" />
            {regenerateDisabled ? 'Regenerating…' : 'Regenerate walkthrough'}
          </button>
        ) : null}
      </div>
      <Narration prose="These changes arrived after the walkthrough was generated and are not part of its narrative yet." />
    </div>
  );
}

const createWalkthroughBlocks = (
  files: ReadonlyArray<ChangedFile>,
  walkthroughView: WalkthroughView,
  currentIndex: number,
): WalkthroughBlockSet => {
  const blocks: Array<ReviewDiffBlock> = [];
  const firstBlockIdByStop: Array<string | null> = [];
  const stopIndexByBlockId = new Map<string, number>();

  for (const stop of walkthroughView.sequence) {
    const focusedRuns = getFocusedRunDiffs(stop, files);
    if (focusedRuns.length === 0) {
      const blockId = `walkthrough:${stop.id}:missing`;
      firstBlockIdByStop[stop.index] = blockId;
      stopIndexByBlockId.set(blockId, stop.index);
      blocks.push({
        header: <StopHeader current={stop.index === currentIndex} stop={stop} />,
        headerSelected: stop.index === currentIndex,
        id: blockId,
      });
      continue;
    }

    firstBlockIdByStop[stop.index] = `walkthrough:${stop.id}:0`;

    focusedRuns.forEach(({ file, note, reviewIdentity }, runIndex) => {
      const blockId = `walkthrough:${stop.id}:${runIndex}`;
      stopIndexByBlockId.set(blockId, stop.index);
      blocks.push({
        file,
        header:
          runIndex === 0 ? <StopHeader current={stop.index === currentIndex} stop={stop} /> : null,
        headerSelected: stop.index === currentIndex,
        id: blockId,
        itemIdPrefix: blockId,
        note,
        reviewIdentity,
      });
    });
  }

  return { blocks, firstBlockIdByStop, stopIndexByBlockId };
};

const getBlockReviewTarget = (
  blocks: ReadonlyArray<ReviewDiffBlock>,
  blockId: string | null | undefined,
): WalkthroughReviewTarget | null => {
  const block = blockId ? blocks.find((candidate) => candidate.id === blockId) : null;
  return block?.file && block.reviewIdentity
    ? {
        file: block.file,
        reviewIdentity: block.reviewIdentity,
      }
    : null;
};

const createSupportBlocks = (
  files: ReadonlyArray<ChangedFile>,
  selected: boolean,
  walkthroughView: WalkthroughView,
  showWhitespace: boolean,
  changedPaths?: ReadonlySet<string>,
  onRegenerateWalkthrough?: () => void,
  regenerateDisabled?: boolean,
): ReadonlyArray<ReviewDiffBlock> => {
  const blocks: Array<ReviewDiffBlock> = [];
  for (const group of walkthroughView.supportByReason) {
    for (const item of group.files) {
      getFocusedRunDiffs(item, files).forEach(({ file, note, reviewIdentity }, runIndex) => {
        const blockId = `walkthrough:support:${item.id}:${runIndex}`;
        const isFirstBlock = blocks.length === 0;
        blocks.push({
          file,
          header: isFirstBlock ? <SupportHeader current={selected} /> : null,
          headerSelected: selected,
          id: blockId,
          itemIdPrefix: blockId,
          note: note ?? item.note ?? group.reason,
          reviewIdentity,
        });
      });
    }
  }

  const uncoveredFiles = getUncoveredWalkthroughFiles(files, walkthroughView, showWhitespace);
  // Changes that arrived after the walkthrough was generated (e.g. via an
  // in-place refresh) get their own "Changed" section; other uncovered hunks
  // stay under "Support" as before.
  const changedFiles = uncoveredFiles.filter((file) => changedPaths?.has(file.path));
  const uncoveredSupportFiles = uncoveredFiles.filter((file) => !changedPaths?.has(file.path));

  for (const file of uncoveredSupportFiles) {
    const blockId = `walkthrough:uncovered:${file.path}`;
    const isFirstBlock = blocks.length === 0;
    blocks.push({
      file,
      header: isFirstBlock ? <SupportHeader current={selected} /> : null,
      headerSelected: selected,
      id: blockId,
      itemIdPrefix: blockId,
      note: 'Not included in the generated walkthrough.',
      reviewIdentity: {
        fingerprint: file.fingerprint,
        key: blockId,
      },
    });
  }

  changedFiles.forEach((file, fileIndex) => {
    const blockId = `walkthrough:changed:${file.path}`;
    blocks.push({
      file,
      header:
        fileIndex === 0 ? (
          <ChangedHeader
            current={selected}
            onRegenerate={onRegenerateWalkthrough}
            regenerateDisabled={regenerateDisabled}
          />
        ) : null,
      headerSelected: selected,
      id: blockId,
      itemIdPrefix: blockId,
      note: 'Changed after the walkthrough was generated.',
      reviewIdentity: {
        fingerprint: file.fingerprint,
        key: blockId,
      },
    });
  });

  return blocks;
};

function Arc({
  committable,
  navigation,
  onShareWalkthrough,
  shareWalkthroughDisabled = false,
  supportAvailable,
  walkthroughView,
}: {
  committable: boolean;
  navigation: NarrativeNavigation;
  onShareWalkthrough?: () => void;
  shareWalkthroughDisabled?: boolean;
  supportAvailable: boolean;
  walkthroughView: WalkthroughView;
}) {
  const currentIndex =
    navigation.mode === 'stop'
      ? navigation.index
      : navigation.mode === 'support'
        ? walkthroughView.sequence.length
        : -1;
  const trackRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ end: false, start: false });
  const goArcNext = useCallback(() => {
    if (navigation.mode === 'stop') {
      if (navigation.index < walkthroughView.sequence.length - 1) {
        navigation.goNext();
      } else if (supportAvailable) {
        navigation.openSupport();
      } else if (committable) {
        navigation.enterCommit();
      }
    } else if (navigation.mode === 'support' && committable) {
      navigation.enterCommit();
    }
  }, [committable, navigation, supportAvailable, walkthroughView]);
  const goArcPrev = useCallback(() => {
    if (navigation.mode === 'stop') {
      navigation.goPrev();
    } else if (navigation.mode === 'support') {
      navigation.goStop(walkthroughView.sequence.length - 1);
    } else if (navigation.mode === 'commit') {
      if (supportAvailable) {
        navigation.openSupport();
      } else {
        navigation.goStop(walkthroughView.sequence.length - 1);
      }
    }
  }, [navigation, supportAvailable, walkthroughView]);
  const canGoPrev =
    navigation.mode === 'stop'
      ? navigation.index > 0
      : navigation.mode === 'support'
        ? walkthroughView.sequence.length > 0
        : navigation.mode === 'commit' && walkthroughView.sequence.length > 0;
  const canGoNext =
    navigation.mode === 'stop'
      ? navigation.index < walkthroughView.sequence.length - 1 || supportAvailable || committable
      : navigation.mode === 'support' && committable;

  // The arc never shows a scrollbar; instead it fades the side that has more.
  const updateOverflow = useCallback(() => {
    const el = trackRef.current;
    if (!el) {
      return;
    }
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
    setOverflow((current) =>
      current.start === start && current.end === end ? current : { end, start },
    );
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) {
      return;
    }
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    el.addEventListener('scroll', updateOverflow, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', updateOverflow);
    };
  }, [updateOverflow]);

  // Keep the focused node in view as Prev/Next moves it, without a scrollbar.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) {
      return;
    }
    const node = el.querySelector<HTMLElement>('.wt-arc-node.current, .wt-arc-bundle.current');
    if (node) {
      const nodeRect = node.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      el.scrollBy({
        left: nodeRect.left + nodeRect.width / 2 - (elRect.left + elRect.width / 2),
      });
    }
    const timer = window.setTimeout(updateOverflow, 220);
    return () => window.clearTimeout(timer);
  }, [currentIndex, navigation.mode, updateOverflow]);

  return (
    <div className="wt-arc">
      <button className="wt-arc-nav" disabled={!canGoPrev} onClick={goArcPrev} type="button">
        <CaretLeft size={16} />
      </button>
      <div
        className={`wt-arc-track${overflow.start ? ' overflow-start' : ''}${
          overflow.end ? ' overflow-end' : ''
        }`}
        ref={trackRef}
      >
        {walkthroughView.chapters.map((chapter, chapterIndex) => (
          <Fragment key={chapter.id}>
            {chapterIndex > 0 ? <span className="wt-arc-join" /> : null}
            <div className="wt-arc-chapter">
              <span className="wt-arc-chapter-label">
                <ChapterIcon icon={chapter.icon} size={13} />
                {chapter.title}
              </span>
              <div className="wt-arc-nodes">
                {chapter.stops.map((stop) => {
                  const state =
                    stop.index === currentIndex
                      ? 'current'
                      : navigation.visited.has(stop.id)
                        ? 'visited'
                        : 'upcoming';
                  return (
                    <button
                      className={`wt-arc-node ${state}`}
                      key={stop.id}
                      onClick={() => navigation.goStop(stop.index)}
                      title={stop.title ?? walkthroughItemTitleFallback(stop)}
                      type="button"
                    >
                      {state === 'visited' ? (
                        <Check size={12} weight="bold" />
                      ) : (
                        <span>{stop.index + 1}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </Fragment>
        ))}
        {supportAvailable ? (
          <>
            <span className="wt-arc-join" />
            <div className="wt-arc-chapter support">
              <span className="wt-arc-chapter-label">
                <Path size={13} />
                Support
              </span>
              <button
                className={`wt-arc-bundle ${
                  navigation.mode === 'support'
                    ? 'current'
                    : navigation.supportVisited
                      ? 'visited'
                      : 'upcoming'
                }`}
                onClick={navigation.openSupport}
                title="Review supporting files"
                type="button"
              >
                <span>{walkthroughView.sequence.length + 1}</span>
              </button>
            </div>
          </>
        ) : null}
        {committable || onShareWalkthrough ? (
          <>
            <span className="wt-arc-join dashed" />
            <div className="wt-arc-chapter">
              <span className="wt-arc-chapter-label">
                {committable ? <GitBranch size={13} /> : <ShareNetwork size={13} />}
                {committable && onShareWalkthrough ? 'Finish' : committable ? 'Commit' : 'Share'}
              </span>
              <div className="wt-arc-nodes wt-arc-action-nodes">
                {committable ? (
                  <button
                    className={`wt-arc-node${navigation.mode === 'commit' ? ' current' : ''}`}
                    onClick={navigation.enterCommit}
                    title="Commit the staged change"
                    type="button"
                  >
                    <GitBranch size={13} />
                  </button>
                ) : null}
                {onShareWalkthrough ? (
                  <button
                    aria-label={
                      shareWalkthroughDisabled ? 'Sharing walkthrough' : 'Share walkthrough'
                    }
                    className="wt-arc-node wt-arc-share-node"
                    disabled={shareWalkthroughDisabled}
                    onClick={onShareWalkthrough}
                    title={shareWalkthroughDisabled ? 'Sharing walkthrough' : 'Share walkthrough'}
                    type="button"
                  >
                    <ShareNetwork aria-hidden size={13} />
                  </button>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </div>
      <button className="wt-arc-nav" disabled={!canGoNext} onClick={goArcNext} type="button">
        <CaretRight size={16} />
      </button>
    </div>
  );
}

export function NarrativeWalkthroughView({
  allowCommit = true,
  changedPaths,
  files,
  navigation,
  onActiveReviewTargetChange,
  onCommit,
  onRegenerateWalkthrough,
  onShareWalkthrough,
  onUpdateCommitMessage,
  regenerateDisabled,
  renderDiffBlocks,
  shareWalkthroughDisabled,
  showWhitespace,
  walkthrough,
}: {
  allowCommit?: boolean;
  changedPaths?: ReadonlySet<string>;
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  onActiveReviewTargetChange: (target: WalkthroughReviewTarget | null) => void;
  onCommit: CommitHandler;
  onRegenerateWalkthrough?: () => void;
  onShareWalkthrough?: () => void;
  onUpdateCommitMessage: CommitMessageHandler;
  regenerateDisabled?: boolean;
  renderDiffBlocks: RenderWalkthroughDiffBlocks;
  shareWalkthroughDisabled?: boolean;
  showWhitespace: boolean;
  walkthrough: NarrativeWalkthrough;
}) {
  const { walkthroughView } = navigation;
  const committable = allowCommit && isWalkthroughCommittable(walkthrough);
  const walkthroughBlocks = useMemo(
    () =>
      walkthroughView
        ? createWalkthroughBlocks(files, walkthroughView, navigation.index)
        : emptyWalkthroughBlockSet,
    [files, navigation.index, walkthroughView],
  );
  const supportBlocks = useMemo(
    () =>
      walkthroughView
        ? createSupportBlocks(
            files,
            navigation.mode === 'support',
            walkthroughView,
            showWhitespace,
            changedPaths,
            onRegenerateWalkthrough,
            regenerateDisabled,
          )
        : [],
    [
      changedPaths,
      files,
      navigation.mode,
      onRegenerateWalkthrough,
      regenerateDisabled,
      showWhitespace,
      walkthroughView,
    ],
  );
  const supportAvailable = supportBlocks.length > 0;
  const firstSupportBlockId = supportBlocks[0]?.id ?? null;
  const supportBlockIds = useMemo(
    () => new Set(supportBlocks.map((block) => block.id)),
    [supportBlocks],
  );
  const reviewBlocks = useMemo(
    () => [...walkthroughBlocks.blocks, ...supportBlocks],
    [supportBlocks, walkthroughBlocks.blocks],
  );
  const activeBlockId = walkthroughBlocks.firstBlockIdByStop[navigation.scrollTarget.index];
  const reviewBlockScrollTarget: WalkthroughBlockScrollTarget | null =
    navigation.mode === 'support' && firstSupportBlockId
      ? {
          behavior: 'smooth',
          blockId: firstSupportBlockId,
          request: navigation.supportScrollRequest,
        }
      : navigation.mode === 'stop' && activeBlockId
        ? {
            behavior: 'smooth',
            blockId: activeBlockId,
            request: navigation.scrollTarget.nonce,
          }
        : null;
  const handleActiveBlockChange = useCallback(
    (blockId: string) => {
      onActiveReviewTargetChange(getBlockReviewTarget(reviewBlocks, blockId));
      if (supportBlockIds.has(blockId)) {
        navigation.syncSupportFromScroll();
        return;
      }
      const stopIndex = walkthroughBlocks.stopIndexByBlockId.get(blockId);
      if (stopIndex != null) {
        navigation.syncIndexFromScroll(stopIndex);
      }
    },
    [navigation, onActiveReviewTargetChange, reviewBlocks, supportBlockIds, walkthroughBlocks],
  );
  useEffect(() => {
    if (navigation.mode === 'stop') {
      onActiveReviewTargetChange(getBlockReviewTarget(reviewBlocks, activeBlockId));
    } else if (navigation.mode === 'support') {
      onActiveReviewTargetChange(getBlockReviewTarget(reviewBlocks, firstSupportBlockId));
    } else {
      onActiveReviewTargetChange(null);
    }
  }, [
    activeBlockId,
    firstSupportBlockId,
    navigation.mode,
    onActiveReviewTargetChange,
    reviewBlocks,
  ]);

  // j/k and Ctrl+↑/↓ move between stops, matching the prototype and Codiff's
  // hunk navigation. Ignore while typing into a comment or input.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))
      ) {
        return;
      }
      if (!walkthroughView) {
        return;
      }
      const direction = getWalkthroughNavigationKeyDirection(event);
      if (direction === 1) {
        event.preventDefault();
        if (navigation.mode === 'stop') {
          if (navigation.index < walkthroughView.sequence.length - 1) {
            navigation.goNext();
          } else if (supportAvailable) {
            navigation.openSupport();
          } else if (committable) {
            navigation.enterCommit();
          }
        } else if (navigation.mode === 'support' && committable) {
          navigation.enterCommit();
        }
      } else if (direction === -1) {
        event.preventDefault();
        if (navigation.mode === 'stop') {
          navigation.goPrev();
        } else if (navigation.mode === 'support') {
          navigation.goStop(navigation.index);
        } else if (navigation.mode === 'commit') {
          if (supportAvailable) {
            navigation.openSupport();
          } else {
            navigation.goStop(navigation.index);
          }
        }
      }
    },
    [committable, navigation, supportAvailable, walkthroughView],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!walkthroughView) {
    return <div className="wt-empty">This walkthrough has no readable sequence.</div>;
  }

  const next = walkthroughView.sequence[navigation.index + 1];
  const supportFiles = formatWalkthroughFileList(
    supportBlocks.flatMap((block) => (block.file ? [block.file.path] : [])),
  );
  const allStopsVisited =
    walkthroughView.sequence.length > 0 &&
    walkthroughView.sequence.every((stop) => navigation.visited.has(stop.id)) &&
    (!supportAvailable || navigation.supportVisited);
  const totalSteps = walkthroughView.sequence.length + (supportAvailable ? 1 : 0);
  const completionAction = allStopsVisited
    ? committable
      ? {
          onClick: navigation.enterCommit,
          title: 'Commit the change',
        }
      : {
          file: `${totalSteps} steps`,
          onClick: null,
          title: 'All chapters reviewed',
        }
    : null;

  return (
    <div
      className="wt-hybrid"
      onPointerDownCapture={navigation.releaseStopScrollLock}
      onTouchStartCapture={navigation.releaseStopScrollLock}
      onWheelCapture={navigation.releaseStopScrollLock}
    >
      <Arc
        committable={committable}
        navigation={navigation}
        onShareWalkthrough={onShareWalkthrough}
        shareWalkthroughDisabled={shareWalkthroughDisabled}
        supportAvailable={supportAvailable}
        walkthroughView={walkthroughView}
      />

      {navigation.mode === 'commit' ? (
        <CommitView
          branch={walkthrough.repo.branch}
          draft={navigation}
          model={buildCommitModel(walkthroughView, files)}
          onCommit={onCommit}
          onUpdateMessage={onUpdateCommitMessage}
        />
      ) : walkthroughView.sequence.length > 0 ? (
        renderDiffBlocks(reviewBlocks, reviewBlockScrollTarget, handleActiveBlockChange)
      ) : (
        renderDiffBlocks(reviewBlocks, reviewBlockScrollTarget, handleActiveBlockChange)
      )}

      {navigation.mode === 'commit' ? null : completionAction ? (
        <button
          className="wt-upnext complete"
          disabled={!completionAction.onClick}
          onClick={completionAction.onClick ?? undefined}
          type="button"
        >
          <span className="wt-upnext-action">
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">Walkthrough complete:</span>{' '}
              <span className="wt-upnext-title">{completionAction.title}</span>
            </span>
            {'file' in completionAction ? (
              <span className="wt-upnext-file">{completionAction.file}</span>
            ) : null}
            <span className="wt-upnext-complete-check">
              <Check size={12} weight="bold" />
            </span>
          </span>
        </button>
      ) : navigation.mode === 'stop' && next ? (
        <button className="wt-upnext" onClick={navigation.goNext} type="button">
          <span className="wt-upnext-action">
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">Next:</span>{' '}
              <span className="wt-upnext-title">
                {next.title ?? walkthroughItemTitleFallback(next)}
              </span>
            </span>
            <span className="wt-upnext-file">
              {walkthroughFileName(walkthroughItemPaths(next)[0] ?? '')}
            </span>
            <ArrowRight size={17} />
          </span>
        </button>
      ) : navigation.mode === 'stop' && supportAvailable ? (
        <button className="wt-upnext" onClick={navigation.openSupport} type="button">
          <span className="wt-upnext-action">
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">Next:</span>{' '}
              <span className="wt-upnext-title">Support</span>
            </span>
            <span className="wt-upnext-file" title={supportFiles.title}>
              {supportFiles.label}
            </span>
            <ArrowRight size={17} />
          </span>
        </button>
      ) : navigation.mode === 'stop' && committable ? (
        <button className="wt-upnext commit" onClick={navigation.enterCommit} type="button">
          <span className="wt-upnext-action">
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">End of sequence:</span>{' '}
              <span className="wt-upnext-title">Commit the change</span>
            </span>
            <ArrowRight size={17} />
          </span>
        </button>
      ) : navigation.mode === 'support' && committable ? (
        <button className="wt-upnext commit" onClick={navigation.enterCommit} type="button">
          <span className="wt-upnext-action">
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">Done skimming:</span>{' '}
              <span className="wt-upnext-title">Commit the change</span>
            </span>
            <ArrowRight size={17} />
          </span>
        </button>
      ) : navigation.mode === 'support' ? (
        <button
          className="wt-upnext"
          onClick={() => navigation.goStop(navigation.index)}
          type="button"
        >
          <span className="wt-upnext-action">
            <ArrowLeft className="wt-upnext-back-icon" size={17} />
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">Previous:</span>{' '}
              <span className="wt-upnext-title">
                {walkthroughView.sequence[navigation.index]?.title ??
                  (walkthroughView.sequence[navigation.index]
                    ? walkthroughItemTitleFallback(walkthroughView.sequence[navigation.index])
                    : '')}
              </span>
            </span>
            <span className="wt-upnext-file">Chapter {navigation.index + 1}</span>
          </span>
        </button>
      ) : null}
    </div>
  );
}
