import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/GitBranch';
import { GitCommitIcon as GitCommit } from '@phosphor-icons/react/GitCommit';
import { GitPullRequestIcon as GitPullRequest } from '@phosphor-icons/react/GitPullRequest';
import { PlusIcon as Plus } from '@phosphor-icons/react/Plus';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { OpenReviewSourceKind } from '../../types.ts';

const menuActions: ReadonlyArray<{
  icon: ReactNode;
  kind: OpenReviewSourceKind;
  label: string;
}> = [
  {
    icon: <GitPullRequest aria-hidden size={15} weight="bold" />,
    kind: 'pull-request',
    label: 'Open PR',
  },
  {
    icon: <GitBranch aria-hidden size={15} weight="bold" />,
    kind: 'branch',
    label: 'Open Branch',
  },
  {
    icon: <GitCommit aria-hidden size={15} weight="bold" />,
    kind: 'commit',
    label: 'Open Commit',
  },
];

export function OpenReviewSourceMenu({ onOpen }: { onOpen: (kind: OpenReviewSourceKind) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) {
      return;
    }

    itemRefs.current[0]?.focus();
    const dismiss = (event: PointerEvent) => {
      // oxlint-disable-next-line @nkzw/no-instanceof
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  const closeWithFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const handleTriggerKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
    }
  }, []);

  const handleMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Tab') {
        setOpen(false);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeWithFocus();
        return;
      }

      const items = itemRefs.current.filter((item) => item != null);
      if (!items.length) {
        return;
      }
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex =
        event.key === 'ArrowDown'
          ? (currentIndex + 1) % items.length
          : event.key === 'ArrowUp'
            ? (currentIndex - 1 + items.length) % items.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : null;
      if (nextIndex != null) {
        event.preventDefault();
        items[nextIndex]?.focus();
      }
    },
    [closeWithFocus],
  );

  return (
    <div className="open-review-source-menu" ref={rootRef}>
      <button
        aria-controls={open ? 'open-review-source-menu' : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Open a PR, branch, or commit"
        className="open-review-source-trigger"
        id="open-review-source-trigger"
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        title="Open a PR, branch, or commit"
        type="button"
      >
        <Plus aria-hidden size={16} weight="bold" />
      </button>
      {open ? (
        <div
          aria-labelledby="open-review-source-trigger"
          className="open-review-source-menu-list"
          id="open-review-source-menu"
          onKeyDown={handleMenuKeyDown}
          role="menu"
        >
          {menuActions.map((action, index) => (
            <button
              className="open-review-source-menu-item"
              key={action.kind}
              onClick={() => {
                setOpen(false);
                onOpen(action.kind);
              }}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              role="menuitem"
              tabIndex={-1}
              type="button"
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
