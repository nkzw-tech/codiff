import '@nkzw/codiff-core/styles.css';
import './styles.css';
import type { SharedWalkthroughSnapshot } from '@nkzw/codiff-core';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usePageTitle } from './sharing/utils.ts';
import ViewerError from './sharing/ViewerError.tsx';
import { WalkthroughViewer } from './sharing/WalkthroughViewer.tsx';

export const EvalShareViewer = () => {
  const [snapshot, setSnapshot] = useState<SharedWalkthroughSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    fetch('/__codiff_eval/manifest', { signal: AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Unable to load local eval manifest (${response.status}).`);
        }
        return (await response.json()) as SharedWalkthroughSnapshot;
      })
      .then(setSnapshot, (error: unknown) =>
        setError(error instanceof Error ? error : new Error(String(error))),
      );
  }, []);

  usePageTitle(snapshot ? snapshot.walkthrough.title : 'Codiff Eval Share');

  if (error) {
    return <ViewerError detail={error} title="Local eval walkthrough unavailable" />;
  }
  return snapshot ? (
    <WalkthroughViewer snapshot={snapshot} />
  ) : (
    <main className="loading">Loading…</main>
  );
};

const root = document.querySelector('#root');
if (!root) {
  throw new Error('Missing eval share root.');
}

createRoot(root).render(<EvalShareViewer />);
