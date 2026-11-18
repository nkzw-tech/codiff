import { useEffect, useRef } from 'react';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import type { SidebarMode, WalkthroughError } from '../../lib/app-types.ts';
import { isNativeInputTarget } from '../../lib/keyboard.ts';
import type { ChangedFile, HistoryEntry, NarrativeWalkthrough, ReviewSource } from '../../types.ts';
import { Button } from './Button.tsx';
import { DiffSummaryFooter } from './DiffSummaryFooter.tsx';
import { ReviewFileTree } from './FileTree.tsx';
import { HistorySidebar } from './HistorySidebar.tsx';
import { NarrativeSidebar } from './walkthrough/NarrativeSidebar.tsx';
import type { NarrativeNavigation } from './walkthrough/useNarrativeNavigation.ts';
import { WalkthroughProgress } from './walkthrough/WalkthroughProgress.tsx';

export function Sidebar({
  commitFiles,
  commitViewOpen,
  currentSource,
  files,
  historyEntries,
  historyHasMore,
  historyLoading,
  historySource,
  keymap,
  mode,
  narrativeNavigation,
  narrativeWalkthrough,
  onActivatePath,
  onLoadMoreHistory,
  onSearchQueryChange,
  onSelectSource,
  onShareWalkthrough,
  onToggleCommitView,
  reloadDeltaPaths,
  searchQuery,
  selectedPath,
  shareWalkthroughDisabled,
  showWhitespace,
  summaryLoading,
  viewed,
  walkthroughError,
  walkthroughLoading,
  walkthroughProgress,
}: {
  commitFiles: ReadonlyArray<ChangedFile>;
  commitViewOpen: boolean;
  currentSource: ReviewSource;
  files: ReadonlyArray<ChangedFile>;
  historyEntries: ReadonlyArray<HistoryEntry>;
  historyHasMore: boolean;
  historyLoading: boolean;
  historySource: ReviewSource | null;
  keymap: CodiffKeymap;
  mode: SidebarMode;
  narrativeNavigation: NarrativeNavigation;
  narrativeWalkthrough: NarrativeWalkthrough | null;
  onActivatePath: (path: string) => void;
  onLoadMoreHistory: () => void;
  onSearchQueryChange: (query: string) => void;
  onSelectSource: (source: ReviewSource) => void;
  onShareWalkthrough?: () => void;
  onToggleCommitView: () => void;
  reloadDeltaPaths: ReadonlySet<string>;
  searchQuery: string;
  selectedPath: string | null;
  shareWalkthroughDisabled?: boolean;
  showWhitespace: boolean;
  summaryLoading: boolean;
  viewed: Record<string, string>;
  walkthroughError: WalkthroughError | null;
  walkthroughLoading: boolean;
  walkthroughProgress: {
    phase: import('../../types.ts').WalkthroughProgressPhase | null;
    responseLabelIndex: number;
    stageRevision: number;
  };
}) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const showCommitButton =
    !summaryLoading &&
    mode === 'tree' &&
    currentSource.type === 'working-tree' &&
    commitFiles.length > 0;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isNativeInputTarget(event.target) && matchesShortcut(event, keymap, 'fileFilter')) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [keymap]);

  return (
    <>
      <div className="sidebar-search-row">
        <input
          aria-label="Filter changed files"
          className="sidebar-search"
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          placeholder={mode === 'history' ? 'Filter history' : 'Filter files'}
          ref={searchInputRef}
          spellCheck={false}
          type="search"
          value={searchQuery}
        />
      </div>
      {mode === 'history' ? (
        <HistorySidebar
          currentSource={currentSource}
          entries={historyEntries}
          hasMore={historyHasMore}
          historySource={historySource}
          loading={historyLoading}
          onLoadMore={onLoadMoreHistory}
          onSelectSource={onSelectSource}
          searchQuery={searchQuery}
        />
      ) : mode === 'walkthrough' && narrativeWalkthrough ? (
        <NarrativeSidebar
          files={commitFiles}
          navigation={narrativeNavigation}
          onShareWalkthrough={onShareWalkthrough}
          shareWalkthroughDisabled={shareWalkthroughDisabled}
          showWhitespace={showWhitespace}
          walkthrough={narrativeWalkthrough}
        />
      ) : mode === 'walkthrough' ? (
        <>
          {walkthroughLoading ? (
            <div className="sidebar-walkthrough-status-shell">
              <div className="sidebar-walkthrough-status codex">
                <WalkthroughProgress
                  phase={walkthroughProgress.phase}
                  responseLabelIndex={walkthroughProgress.responseLabelIndex}
                  stageRevision={walkthroughProgress.stageRevision}
                />
              </div>
            </div>
          ) : walkthroughError ? (
            <div className="sidebar-walkthrough-status" title={walkthroughError.reason}>
              <strong>Walkthrough unavailable</strong>
              <span>{walkthroughError.reason}</span>
            </div>
          ) : null}
        </>
      ) : (
        <ReviewFileTree
          files={files}
          onActivatePath={onActivatePath}
          reloadDeltaPaths={reloadDeltaPaths}
          scrollSelectedPathIntoView
          selectedPath={selectedPath}
          showWhitespace={showWhitespace}
          viewed={viewed}
        />
      )}
      <DiffSummaryFooter
        files={mode === 'history' ? commitFiles : files}
        loading={summaryLoading}
        showWhitespace={showWhitespace}
      >
        {showCommitButton ? (
          <Button
            aria-label={commitViewOpen ? 'Show file tree' : 'Open commit view'}
            className="sidebar-commit-button"
            onClick={onToggleCommitView}
            type="button"
          >
            {commitViewOpen ? 'Tree' : 'Commit'}
          </Button>
        ) : null}
      </DiffSummaryFooter>
    </>
  );
}
