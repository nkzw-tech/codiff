import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { Copy as LucideCopy } from 'lucide-react';
import { type MouseEvent as ReactMouseEvent, useCallback } from 'react';
import { useCopiedState } from './useCopiedState.ts';

export function CopyCodeButton({ className, code }: { className?: string; code: string }) {
  const [copied, markCopied] = useCopiedState(1600);

  const handleClick = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      // The button can live inside `<summary>`, which would otherwise toggle.
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        return;
      }
      markCopied();
    },
    [code, markCopied],
  );

  const label = copied ? 'Code copied' : 'Copy code';

  return (
    <button
      aria-label={label}
      className={`codiff-copy-path-button codiff-copy-code-button${copied ? ' copied' : ''}${className ? ` ${className}` : ''}`}
      onClick={(event) => void handleClick(event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation();
        }
      }}
      title={label}
      type="button"
    >
      {copied ? (
        <Check aria-hidden className="codiff-copy-path-icon check" size={16} weight="bold" />
      ) : (
        <LucideCopy aria-hidden className="codiff-copy-path-icon" size={16} strokeWidth={2.25} />
      )}
    </button>
  );
}
