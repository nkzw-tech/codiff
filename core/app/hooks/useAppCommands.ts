import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ReviewComment, ReviewIdentity, SidebarMode } from '../../lib/app-types.ts';
import { createCommandRegistry, type Command } from '../../lib/command-registry.ts';
import type { ReviewCommandTarget } from '../../lib/review-command-target.ts';
import { buildReviewCommentsMarkdown } from '../../lib/review-comments.ts';
import { isReviewIdentityViewed } from '../../lib/review-identity.ts';
import type {
  ChangedFile,
  CodiffPreferences,
  OpenReviewSourceKind,
  RepositoryState,
} from '../../types.ts';

type UseAppCommandsOptions = {
  changeSidebarMode: (mode: SidebarMode) => void;
  focusFileFilter: () => void;
  getReviewCommandTarget: () => ReviewCommandTarget | null;
  onOpenDiffSearch: () => void;
  onOpenReviewSource: (kind: OpenReviewSourceKind) => void;
  onOpenSelectedFile: () => void;
  onRefreshRepository: () => void;
  onToggleSidebar: () => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean, reviewIdentity: ReviewIdentity) => void;
  onToggleWordWrap: () => void;
  preferencesRef: RefObject<CodiffPreferences>;
  reviewCommentsRef: RefObject<ReadonlyArray<ReviewComment>>;
  stateRef: RefObject<RepositoryState | null>;
  viewedRef: RefObject<Record<string, string>>;
};

export function useAppCommands({
  changeSidebarMode,
  focusFileFilter,
  getReviewCommandTarget,
  onOpenDiffSearch,
  onOpenReviewSource,
  onOpenSelectedFile,
  onRefreshRepository,
  onToggleSidebar,
  onToggleViewed,
  onToggleWordWrap,
  preferencesRef,
  reviewCommentsRef,
  stateRef,
  viewedRef,
}: UseAppCommandsOptions) {
  const registryRef = useRef(createCommandRegistry());
  const [commands, setCommands] = useState<ReadonlyArray<Command>>([]);

  useEffect(() => {
    const registry = registryRef.current;
    const unregisterFns = [
      registry.register({
        execute: focusFileFilter,
        id: 'file-filter',
        keymapAction: 'fileFilter',
        title: 'Focus File Filter',
      }),
      registry.register({
        execute: onOpenDiffSearch,
        id: 'diff-search',
        keymapAction: 'diffSearch',
        title: 'Find in Diffs',
      }),
      registry.register({
        execute: () => onOpenReviewSource('pull-request'),
        id: 'open-pull-request',
        title: 'Open PR',
      }),
      registry.register({
        execute: () => onOpenReviewSource('commit'),
        id: 'open-commit',
        title: 'Open Commit',
      }),
      registry.register({
        execute: () => onOpenReviewSource('branch'),
        id: 'open-branch',
        title: 'Open Branch',
      }),
      registry.register({
        execute: () => {
          void window.codiff.openRepositoryFolder().catch(() => {});
        },
        id: 'open-folder',
        title: 'Open Folder',
      }),
      registry.register({
        execute: () => changeSidebarMode('tree'),
        id: 'sidebar-tree',
        title: 'Show File Tree',
      }),
      registry.register({
        execute: () => changeSidebarMode('history'),
        id: 'sidebar-history',
        title: 'Show History',
      }),
      registry.register({
        execute: () => changeSidebarMode('walkthrough'),
        id: 'sidebar-walkthrough',
        title: 'Show Walkthrough',
      }),
      registry.register({
        execute: () => {
          const currentState = stateRef.current;
          if (!currentState) {
            return;
          }

          const markdown = buildReviewCommentsMarkdown(
            currentState.files,
            reviewCommentsRef.current,
            preferencesRef.current.showWhitespace,
            preferencesRef.current.reviewCommentsPrefix,
          );
          if (markdown) {
            void navigator.clipboard.writeText(markdown);
          }
        },
        id: 'copy-comments',
        title: 'Copy Review Comments',
      }),
      registry.register({
        execute: () => {
          const currentState = stateRef.current;
          if (!currentState) {
            return;
          }

          const markdown = buildReviewCommentsMarkdown(
            currentState.files,
            reviewCommentsRef.current,
            preferencesRef.current.showWhitespace,
            preferencesRef.current.reviewCommentsPrefix,
          );
          if (markdown) {
            void navigator.clipboard.writeText(markdown).then(() => {
              window.close();
            });
          } else {
            window.close();
          }
        },
        id: 'copy-comments-and-close',
        title: 'Copy Review Comments and Close',
      }),
      registry.register({
        description: () => getReviewCommandTarget()?.file.path ?? null,
        execute: () => {
          const target = getReviewCommandTarget();
          if (!target) {
            return;
          }

          const isViewed = isReviewIdentityViewed(viewedRef.current, target.reviewIdentity);
          onToggleViewed(target.file, isViewed, target.reviewIdentity);
        },
        id: 'toggle-viewed',
        title: 'Toggle Viewed',
      }),
      registry.register({
        description: () => getReviewCommandTarget()?.file.path ?? null,
        execute: onOpenSelectedFile,
        id: 'open-file',
        keymapAction: 'openFile',
        title: 'Open File in Editor',
      }),
      registry.register({
        execute: onToggleSidebar,
        id: 'toggle-sidebar',
        keymapAction: 'toggleSidebar',
        title: 'Toggle Sidebar',
      }),
      registry.register({
        execute: () => {
          void window.codiff.setShowOutdated(!preferencesRef.current.showOutdated).catch(() => {});
        },
        id: 'toggle-outdated-comments',
        title: 'Toggle Outdated Comments',
      }),
      registry.register({
        description: () =>
          preferencesRef.current.diffStyle === 'split' ? 'Switch to Unified' : 'Switch to Split',
        execute: () => {
          const nextDiffStyle = preferencesRef.current.diffStyle === 'split' ? 'unified' : 'split';
          void window.codiff.setDiffStyle(nextDiffStyle).catch(() => {});
        },
        id: 'toggle-diff-layout',
        title: 'Toggle Diff Layout',
      }),
      registry.register({
        description: () =>
          preferencesRef.current.wordWrap ? 'Disable Word Wrap' : 'Enable Word Wrap',
        execute: onToggleWordWrap,
        id: 'toggle-word-wrap',
        keymapAction: 'toggleWordWrap',
        title: 'Toggle Word Wrap',
      }),
      registry.register({
        execute: () => {
          void window.codiff.increaseCodeFontSize().catch(() => {});
        },
        id: 'increase-code-font-size',
        title: 'Increase Code Font Size',
      }),
      registry.register({
        execute: () => {
          void window.codiff.decreaseCodeFontSize().catch(() => {});
        },
        id: 'decrease-code-font-size',
        title: 'Decrease Code Font Size',
      }),
      registry.register({
        execute: () => {
          void window.codiff.resetCodeFontSize().catch(() => {});
        },
        id: 'reset-code-font-size',
        title: 'Reset Code Font Size',
      }),
      registry.register({
        execute: () => {
          void window.codiff.openConfigFile().catch(() => {});
        },
        id: 'open-config-file',
        title: 'Open Config File',
      }),
      registry.register({
        execute: onRefreshRepository,
        id: 'reload',
        title: 'Refresh Changes',
      }),
    ];
    setCommands(registry.commands);

    return () => {
      for (const unregister of unregisterFns) {
        unregister();
      }
    };
  }, [
    changeSidebarMode,
    focusFileFilter,
    getReviewCommandTarget,
    onOpenDiffSearch,
    onOpenReviewSource,
    onOpenSelectedFile,
    onRefreshRepository,
    onToggleSidebar,
    onToggleViewed,
    onToggleWordWrap,
    preferencesRef,
    reviewCommentsRef,
    stateRef,
    viewedRef,
  ]);

  return commands;
}
