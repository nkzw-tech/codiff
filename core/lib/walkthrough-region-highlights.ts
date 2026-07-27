import type { WalkthroughRegion } from '../types.ts';

export const applyWalkthroughRegionHighlights = (
  root: ParentNode,
  regions: ReadonlyArray<WalkthroughRegion>,
  activeRegionId?: string,
) => {
  for (const line of root.querySelectorAll<HTMLElement>('[data-walkthrough-region]')) {
    delete line.dataset.walkthroughRegion;
    delete line.dataset.walkthroughRegionActive;
  }

  for (const region of regions) {
    for (const side of root.querySelectorAll<HTMLElement>(`[data-${region.side}]`)) {
      for (let lineNumber = region.startLine; lineNumber <= region.endLine; lineNumber += 1) {
        for (const line of side.querySelectorAll<HTMLElement>(
          `[data-line="${lineNumber}"], [data-column-number="${lineNumber}"]`,
        )) {
          line.dataset.walkthroughRegion = region.id;
          if (region.id === activeRegionId) {
            line.dataset.walkthroughRegionActive = '';
          }
        }
      }
    }
  }
};
