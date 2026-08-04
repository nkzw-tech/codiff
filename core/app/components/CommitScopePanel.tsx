import { useState } from 'react';
import { reviewCommitRange } from '../../lib/review-commit-stack.ts';
import type { GitSha, ReviewCommitListEntry } from '../../types.ts';
import { ReviewCommitRef } from './CommitRefTooltip.tsx';

export type CommitScopePanelProps = {
  commits: ReadonlyArray<ReviewCommitListEntry>;
  onClear: () => void;
  onSelectCommitRange: (range: { fromSha: GitSha; toSha: GitSha } | null) => void;
  selectedCommitRange?: { fromSha: GitSha; toSha: GitSha } | null;
};

export function CommitScopePanel({
  commits,
  onClear,
  onSelectCommitRange,
  selectedCommitRange = null,
}: CommitScopePanelProps) {
  const [rangePickerOpen, setRangePickerOpen] = useState(selectedCommitRange != null);
  const [rangeStartSha, setRangeStartSha] = useState<GitSha | null>(
    selectedCommitRange?.fromSha ?? null,
  );
  const materializeRange = (fromSha: GitSha, toSha: GitSha) => {
    try {
      return reviewCommitRange(commits, fromSha, toSha);
    } catch {
      return null;
    }
  };
  const selectedCommits = selectedCommitRange
    ? (materializeRange(selectedCommitRange.fromSha, selectedCommitRange.toSha)?.members ?? [])
    : [];
  const selectedCommitCount = selectedCommits.length;
  const summary = selectedCommitRange
    ? `${selectedCommitCount} selected commit${selectedCommitCount === 1 ? '' : 's'}`
    : rangeStartSha
      ? 'Choose To'
      : 'All merge request changes';

  return (
    <section className="version-tree-commit-scope">
      <div className="version-tree-commit-scope-header">
        <div className="commit-scope-heading">
          <span className="commit-scope-heading-label">Commit range</span>
          <small>{summary}</small>
        </div>
        {!rangePickerOpen ? (
          <button onClick={() => setRangePickerOpen(true)} type="button">
            View commit range
          </button>
        ) : (
          <button
            aria-label="Clear commit range"
            className="merge-request-nav-button"
            onClick={() => {
              setRangeStartSha(null);
              onClear();
            }}
            title="Clear commit range"
            type="button"
          >
            Clear
          </button>
        )}
      </div>
      {rangePickerOpen ? (
        <div className="version-tree-commit-options">
          <div aria-label="Merge request commits" className="commit-range-list">
            {commits.map((commit) => {
              const selectingTo = rangeStartSha != null && selectedCommitRange == null;
              const disabled = selectingTo && materializeRange(rangeStartSha, commit.sha) == null;
              const selected = selectedCommits.some((candidate) => candidate.sha === commit.sha);
              const isFrom =
                commit.sha === (selectedCommitRange?.fromSha ?? rangeStartSha ?? undefined);
              const isTo = commit.sha === selectedCommitRange?.toSha;
              return (
                <button
                  aria-disabled={disabled}
                  aria-pressed={selected || isFrom}
                  className="version-commit-unit commit-range-row"
                  disabled={disabled}
                  key={commit.sha}
                  onClick={() => {
                    if (!rangeStartSha || selectedCommitRange) {
                      setRangeStartSha(commit.sha);
                      onSelectCommitRange(null);
                      return;
                    }
                    onSelectCommitRange({ fromSha: rangeStartSha, toSha: commit.sha });
                  }}
                  type="button"
                >
                  <span className="commit-range-boundary">
                    {isFrom ? 'From' : isTo ? 'To' : ''}
                  </span>
                  <ReviewCommitRef commit={commit} focusable={false} linkTrigger={false} />
                  <span>{commit.subject}</span>
                </button>
              );
            })}
            {rangeStartSha && !selectedCommitRange ? (
              <small className="commit-range-instruction">Choose To to apply the range.</small>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
