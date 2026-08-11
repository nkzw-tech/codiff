import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { CrosshairSimpleIcon as CrosshairSimple } from '@phosphor-icons/react/CrosshairSimple';
import { ProhibitIcon as Prohibit } from '@phosphor-icons/react/Prohibit';
import { XIcon as X } from '@phosphor-icons/react/X';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { DefinitionCandidate, DefinitionSearchResult } from '../../types.ts';

export function DefinitionPopover({
  anchor,
  getDestination,
  identifier,
  onClose,
  onOpen,
  result,
}: {
  anchor: { x: number; y: number };
  getDestination: (candidate: DefinitionCandidate) => 'diff' | 'editor' | 'unavailable';
  identifier: string;
  onClose: () => void;
  onOpen: (candidate: DefinitionCandidate) => void;
  result: DefinitionSearchResult | null;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !popoverRef.current?.contains(target)) {
        onClose();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOutside);
    };
  }, [onClose]);

  const left = Math.min(anchor.x, Math.max(12, window.innerWidth - 432));
  const top = Math.min(anchor.y + 10, Math.max(12, window.innerHeight - 320));
  return createPortal(
    <div
      aria-label={`Definitions for ${identifier}`}
      className="definition-popover"
      ref={popoverRef}
      role="dialog"
      style={{ left, top }}
    >
      <div className="definition-popover-header">
        <span>
          Definition of <code>{identifier}</code>
        </span>
        <button aria-label="Close definition results" onClick={onClose} type="button">
          <X size={14} />
        </button>
      </div>
      {!result ? (
        <div className="definition-popover-message">Searching…</div>
      ) : result.status === 'unavailable' ? (
        <div className="definition-popover-message">{result.reason}</div>
      ) : result.candidates.length === 0 ? (
        <div className="definition-popover-message">No likely definitions found.</div>
      ) : (
        <div className="definition-popover-results">
          {result.candidates.map((candidate) => {
            const destination = getDestination(candidate);
            const destinationLabel =
              destination === 'diff'
                ? 'Jump within diff'
                : destination === 'editor'
                  ? 'Open in editor'
                  : 'Unavailable outside this historical diff';
            return (
              <button
                className="definition-popover-result"
                disabled={destination === 'unavailable'}
                key={`${candidate.path}:${candidate.lineNumber}`}
                onClick={() => onOpen(candidate)}
                type="button"
              >
                <span className="definition-popover-location">
                  {candidate.path}:{candidate.lineNumber}
                  <span className="definition-popover-meta">
                    <span>{candidate.kind}</span>
                    <span
                      aria-label={destinationLabel}
                      className="definition-popover-destination"
                      role="img"
                      title={destinationLabel}
                    >
                      {destination === 'diff' ? (
                        <CrosshairSimple aria-hidden="true" size={13} />
                      ) : destination === 'editor' ? (
                        <ArrowSquareOut aria-hidden="true" size={13} />
                      ) : (
                        <Prohibit aria-hidden="true" size={13} />
                      )}
                    </span>
                  </span>
                </span>
                <code>{candidate.line}</code>
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}
