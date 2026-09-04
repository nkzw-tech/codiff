import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/GitBranch';
import { PathIcon as Path } from '@phosphor-icons/react/Path';
import { ShareNetworkIcon as ShareNetwork } from '@phosphor-icons/react/ShareNetwork';
import { renderInlineMarkdown } from '../../../lib/markdown.tsx';
import {
  buildCommitModel,
  formatWalkthroughFileLineRows,
  getUncoveredWalkthroughFileLineItems,
  isWalkthroughCommittable,
  resolveWalkthroughFileLineItems,
  walkthroughItemTitleFallback,
  type WalkthroughView,
  type WalkthroughStopView,
} from '../../../lib/narrative-walkthrough.ts';
import type { ChangedFile, NarrativeWalkthrough } from '../../../types.ts';
import { ChapterIcon } from './parts.tsx';
import type { NarrativeNavigation } from './useNarrativeNavigation.ts';

function TocFileRows({
  files,
}: {
  files: ReadonlyArray<{
    added: number;
    deleted: number;
    diffAvailable?: false;
    label: string;
    path?: string;
    title: string;
  }>;
}) {
  return (
    <span className="wt-toc-file-list">
      {files.map((file, index) => (
        <span className="wt-toc-file-row" key={file.path ?? `${file.title}:${file.label}:${index}`}>
          <span className="wt-toc-file" title={file.title}>
            {file.label}
          </span>
          <span className="wt-toc-count">
            {file.diffAvailable === false ? (
              'Diff unavailable'
            ) : (
              <>
                <span className="added">+{file.added}</span>
                {file.deleted > 0 ? <span className="deleted">−{file.deleted}</span> : null}
              </>
            )}
          </span>
        </span>
      ))}
    </span>
  );
}

function TocStop({
  current,
  files,
  onSelect,
  stop,
  visited,
}: {
  current: boolean;
  files: ReadonlyArray<ChangedFile>;
  onSelect: (index: number) => void;
  stop: WalkthroughStopView;
  visited: boolean;
}) {
  const isDone = visited && !current;
  const fileRows = formatWalkthroughFileLineRows(
    resolveWalkthroughFileLineItems(stop.hunks, files),
  );
  const title = stop.title ?? walkthroughItemTitleFallback(stop);
  return (
    <button
      className={`wt-toc-stop${current ? ' current' : ''}${isDone ? ' visited' : ''}`}
      onClick={() => onSelect(stop.index)}
      title={title}
      type="button"
    >
      <span className="wt-toc-rail">
        {isDone ? (
          <span className="wt-toc-node done">
            <Check size={8} weight="bold" />
          </span>
        ) : (
          <span className={`wt-toc-node${current ? ' current' : ''}`}>
            {current ? <span className="wt-toc-node-pulse" /> : null}
          </span>
        )}
      </span>
      <span className="wt-toc-main">
        <span className="wt-toc-title-row">
          <span className="wt-toc-num">{stop.index + 1}</span>
          <span className="wt-toc-title">{title}</span>
        </span>
        <TocFileRows files={fileRows} />
      </span>
    </button>
  );
}

function SupportingFilesStop({
  files,
  navigation,
  showWhitespace,
  walkthroughView,
}: {
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  showWhitespace: boolean;
  walkthroughView: WalkthroughView;
}) {
  const uncoveredFiles = getUncoveredWalkthroughFileLineItems(
    files,
    walkthroughView,
    showWhitespace,
  );
  if (walkthroughView.support.length === 0 && uncoveredFiles.length === 0) {
    return null;
  }
  const current = navigation.mode === 'support';
  const isDone = navigation.supportVisited && !current;
  const fileRows = formatWalkthroughFileLineRows([
    ...resolveWalkthroughFileLineItems(
      walkthroughView.support.flatMap((item) => item.hunks),
      files,
    ),
    ...uncoveredFiles,
  ]);
  return (
    <div className="wt-toc-chapter">
      <div className="wt-toc-chapter-head">
        <span className="wt-toc-chapter-icon">
          <Path size={15} />
        </span>
        <span className="wt-toc-chapter-title">Support</span>
      </div>
      <div className="wt-toc-stops">
        <button
          className={`wt-toc-stop${current ? ' current' : ''}${isDone ? ' visited' : ''}`}
          onClick={navigation.openSupport}
          title="Changed alongside the main walkthrough"
          type="button"
        >
          <span className="wt-toc-rail">
            {isDone ? (
              <span className="wt-toc-node done">
                <Check size={8} weight="bold" />
              </span>
            ) : (
              <span className={`wt-toc-node${current ? ' current' : ''}`}>
                {current ? <span className="wt-toc-node-pulse" /> : null}
              </span>
            )}
          </span>
          <span className="wt-toc-main">
            <TocFileRows files={fileRows} />
          </span>
        </button>
      </div>
    </div>
  );
}

export function NarrativeSidebar({
  allowCommit = true,
  files,
  navigation,
  onShareWalkthrough,
  shareWalkthroughDisabled = false,
  showWhitespace,
  walkthrough,
}: {
  allowCommit?: boolean;
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  onShareWalkthrough?: () => void;
  shareWalkthroughDisabled?: boolean;
  showWhitespace: boolean;
  walkthrough: NarrativeWalkthrough;
}) {
  const { walkthroughView } = navigation;
  if (!walkthroughView) {
    return <div className="wt-empty">This walkthrough has no readable sequence.</div>;
  }

  const currentStopId =
    navigation.mode === 'stop' ? walkthroughView.sequence[navigation.index]?.id : null;

  const committable = allowCommit && isWalkthroughCommittable(walkthrough);
  const commitModel = committable ? buildCommitModel(walkthroughView, files) : null;
  const commitFiles = commitModel
    ? formatWalkthroughFileLineRows(
        commitModel.files.filter((file) => navigation.commitSelected.has(file.path)),
      )
    : null;

  return (
    <div className="walkthrough-list">
      <div className="wt-focus">
        <span className="wt-focus-label">Review focus</span>
        <p>{renderInlineMarkdown(walkthrough.focus)}</p>
      </div>

      <div className="wt-toc-scroll">
        {walkthroughView.chapters.map((chapter) => (
          <div className="wt-toc-chapter" key={chapter.id}>
            <div className="wt-toc-chapter-head">
              <span className="wt-toc-chapter-icon">
                <ChapterIcon icon={chapter.icon} size={15} />
              </span>
              <span className="wt-toc-chapter-title">{chapter.title}</span>
            </div>
            <div className="wt-toc-stops">
              {chapter.stops.map((stop) => (
                <TocStop
                  current={navigation.mode === 'stop' && stop.id === currentStopId}
                  files={files}
                  key={stop.id}
                  onSelect={navigation.goStop}
                  stop={stop}
                  visited={navigation.visited.has(stop.id)}
                />
              ))}
            </div>
          </div>
        ))}
        <SupportingFilesStop
          files={files}
          navigation={navigation}
          showWhitespace={showWhitespace}
          walkthroughView={walkthroughView}
        />
        {committable && commitFiles ? (
          <div className="wt-toc-chapter">
            <div className="wt-toc-chapter-head">
              <span className="wt-toc-chapter-icon commit">
                <GitBranch size={15} />
              </span>
              <span className="wt-toc-chapter-title">Commit</span>
            </div>
            <div
              className={`wt-toc-stop wt-toc-stop-actions${
                navigation.mode === 'commit' ? ' current' : ''
              }`}
            >
              <span className="wt-toc-rail wt-toc-rail-commit">
                <span className={`wt-toc-node${navigation.mode === 'commit' ? ' current' : ''}`}>
                  {navigation.mode === 'commit' ? <span className="wt-toc-node-pulse" /> : null}
                </span>
              </span>
              <span className="wt-toc-main wt-toc-main-actions">
                <button
                  className="wt-toc-commit-action"
                  onClick={navigation.enterCommit}
                  type="button"
                >
                  <span className="wt-toc-title-row">
                    <span className="wt-toc-title">Write the commit</span>
                  </span>
                  <TocFileRows files={commitFiles} />
                </button>
              </span>
            </div>
          </div>
        ) : onShareWalkthrough ? (
          <div className="wt-toc-chapter">
            <div className="wt-toc-chapter-head">
              <span className="wt-toc-chapter-icon commit">
                <ShareNetwork size={15} />
              </span>
              <span className="wt-toc-chapter-title">Share</span>
            </div>
            <div className="wt-toc-stop wt-toc-stop-actions">
              <span className="wt-toc-rail wt-toc-rail-commit">
                <span className="wt-toc-node" />
              </span>
              <span className="wt-toc-main wt-toc-main-actions">
                <button
                  className="wt-toc-commit-action"
                  disabled={shareWalkthroughDisabled}
                  onClick={onShareWalkthrough}
                  type="button"
                >
                  <span className="wt-toc-title-row">
                    <span className="wt-toc-title">Share walkthrough</span>
                  </span>
                </button>
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
