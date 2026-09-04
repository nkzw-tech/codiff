import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { ReviewIdentity } from '../../lib/app-types.ts';
import { isGeneratedWalkthroughFile } from '../../lib/narrative-walkthrough-diff.js';
import {
  getFileReviewIdentity,
  updateReviewIdentityCollapsed,
  updateReviewIdentityViewed,
} from '../../lib/review-identity.ts';
import type { ChangedFile } from '../../types.ts';

type UseReviewFileStateOptions = {
  collapsed?: ReadonlySet<string>;
  initialCollapsed?: ReadonlySet<string>;
  initialSelectedPath?: string | null;
  initialViewed?: Record<string, string>;
  onCollapsedChange?: (collapsed: Set<string>) => void;
  onViewedChange?: (viewed: Record<string, string>) => void;
  viewed?: Readonly<Record<string, string>>;
};

export function useReviewFileState({
  collapsed: controlledCollapsed,
  initialCollapsed = new Set(),
  initialSelectedPath = null,
  initialViewed = {},
  onCollapsedChange,
  onViewedChange,
  viewed: controlledViewed,
}: UseReviewFileStateOptions = {}) {
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState<Set<string>>(
    () => new Set(initialCollapsed),
  );
  const [expandedGenerated, setExpandedGenerated] = useState<Set<string>>(() => new Set());
  const [itemVersionByKey, setItemVersionByKey] = useState<Record<string, number>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(initialSelectedPath);
  const [uncontrolledViewed, setUncontrolledViewed] =
    useState<Record<string, string>>(initialViewed);
  const collapsed = useMemo(
    () => (controlledCollapsed ? new Set(controlledCollapsed) : uncontrolledCollapsed),
    [controlledCollapsed, uncontrolledCollapsed],
  );
  const viewed = controlledViewed ?? uncontrolledViewed;

  const setCollapsed = useCallback<Dispatch<SetStateAction<Set<string>>>>(
    (update) => {
      if (controlledCollapsed == null) {
        setUncontrolledCollapsed((current) => {
          const next = typeof update === 'function' ? update(new Set(current)) : update;
          onCollapsedChange?.(next);
          return next;
        });
        return;
      }
      const current = new Set(controlledCollapsed);
      const next = typeof update === 'function' ? update(current) : update;
      onCollapsedChange?.(next);
    },
    [controlledCollapsed, onCollapsedChange],
  );

  const setViewed = useCallback<Dispatch<SetStateAction<Record<string, string>>>>(
    (update) => {
      if (controlledViewed == null) {
        setUncontrolledViewed((current) => {
          const next = typeof update === 'function' ? update({ ...current }) : update;
          onViewedChange?.(next);
          return next;
        });
        return;
      }
      const current = { ...controlledViewed };
      const next = typeof update === 'function' ? update(current) : update;
      onViewedChange?.(next);
    },
    [controlledViewed, onViewedChange],
  );

  const bumpItemVersion = useCallback((key: string) => {
    setItemVersionByKey((current) => ({
      ...current,
      [key]: (current[key] ?? 0) + 1,
    }));
  }, []);

  const toggleCollapsed = useCallback(
    (file: ChangedFile, isCollapsed: boolean, reviewKey = file.path) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (isCollapsed) {
          next.delete(reviewKey);
        } else {
          next.add(reviewKey);
        }
        return next;
      });
      setExpandedGenerated((current) => {
        const next = new Set(current);
        if (isCollapsed && isGeneratedWalkthroughFile(file)) {
          next.add(reviewKey);
        } else {
          next.delete(reviewKey);
        }
        return next;
      });
      bumpItemVersion(reviewKey);
    },
    [bumpItemVersion, setCollapsed],
  );

  const toggleViewed = useCallback(
    (
      file: ChangedFile,
      isViewed: boolean,
      reviewIdentity: ReviewIdentity = getFileReviewIdentity(file),
    ) => {
      setViewed((current) => {
        return updateReviewIdentityViewed(current, reviewIdentity, isViewed);
      });
      setCollapsed((current) => updateReviewIdentityCollapsed(current, reviewIdentity, isViewed));
      if (!isViewed) {
        setExpandedGenerated((current) => {
          const next = new Set(current);
          next.delete(reviewIdentity.key);
          return next;
        });
      }
      bumpItemVersion(reviewIdentity.key);
    },
    [bumpItemVersion, setCollapsed, setViewed],
  );

  return {
    bumpItemVersion,
    collapsed,
    expandedGenerated,
    itemVersionByKey,
    selectedPath,
    setCollapsed,
    setExpandedGenerated,
    setItemVersionByKey,
    setSelectedPath,
    setViewed,
    toggleCollapsed,
    toggleViewed,
    viewed,
  };
}
