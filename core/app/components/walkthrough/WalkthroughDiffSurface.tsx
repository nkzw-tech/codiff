import type { ComponentProps } from 'react';
import type { ChangedFile } from '../../../types.ts';
import { ReviewCodeView, type ReviewDiffBlock } from '../ReviewCodeView.tsx';
import type { WalkthroughBlockScrollTarget } from './NarrativeWalkthroughView.tsx';

const emptyFiles: ReadonlyArray<ChangedFile> = [];
const emptyPaths = new Set<string>();
const emptyWalkthroughNotes = new Map();

type ReviewCodeViewProps = ComponentProps<typeof ReviewCodeView>;

type WalkthroughReviewProps = Omit<
  ReviewCodeViewProps,
  | 'blocks'
  | 'bottomInset'
  | 'commitMetadata'
  | 'files'
  | 'forceExpandedPaths'
  | 'onActiveBlockChange'
  | 'onSelectPathFromScroll'
  | 'scrollTarget'
  | 'selectedPath'
  | 'showSourceDescription'
  | 'walkthroughNotes'
>;

const ignorePathScroll = () => {};

export function WalkthroughDiffSurface({
  allowViewedToggle,
  blocks,
  forceExpandedPaths = emptyPaths,
  onActiveBlockChange,
  reviewProps,
  scrollTarget,
  sourceDescriptionActions,
  sourceDescriptionFooter,
  sourceDescriptionFooterAside,
}: {
  allowViewedToggle?: boolean;
  blocks: ReadonlyArray<ReviewDiffBlock>;
  forceExpandedPaths?: ReadonlySet<string>;
  onActiveBlockChange: (blockId: string) => void;
  reviewProps: WalkthroughReviewProps;
  scrollTarget: WalkthroughBlockScrollTarget | null;
  sourceDescriptionActions?: ReviewCodeViewProps['sourceDescriptionActions'];
  sourceDescriptionFooter?: ReviewCodeViewProps['sourceDescriptionFooter'];
  sourceDescriptionFooterAside?: ReviewCodeViewProps['sourceDescriptionFooterAside'];
}) {
  return (
    <div className="wt-stop wt-diff-surface">
      <ReviewCodeView
        {...reviewProps}
        allowViewedToggle={allowViewedToggle}
        blocks={blocks}
        bottomInset={96}
        commitMetadata={null}
        files={emptyFiles}
        forceExpandedPaths={forceExpandedPaths}
        onActiveBlockChange={onActiveBlockChange}
        onSelectPathFromScroll={ignorePathScroll}
        scrollTarget={scrollTarget}
        selectedPath={null}
        showSourceDescription
        sourceDescriptionActions={sourceDescriptionActions ?? reviewProps.sourceDescriptionActions}
        sourceDescriptionFooter={sourceDescriptionFooter ?? reviewProps.sourceDescriptionFooter}
        sourceDescriptionFooterAside={
          sourceDescriptionFooterAside ?? reviewProps.sourceDescriptionFooterAside
        }
        walkthroughNotes={emptyWalkthroughNotes}
      />
    </div>
  );
}
