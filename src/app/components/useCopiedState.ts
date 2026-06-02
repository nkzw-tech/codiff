import { useCallback, useEffect, useRef, useState } from 'react';

export function useCopiedState(timeoutMs: number) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  const markCopied = useCallback(() => {
    setCopied(true);
    if (copiedTimerRef.current != null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, timeoutMs);
  }, [timeoutMs]);

  return [copied, markCopied] as const;
}
