import type { GitIdentity, SharedWalkthroughSnapshot } from '@nkzw/codiff-core';
import { SharedWalkthroughApp, type SharedWalkthroughCommenting } from '@nkzw/codiff-service/react';

export function WalkthroughViewer({
  commenting,
  gitIdentity,
  onDeleteShare,
  snapshot,
}: {
  commenting?: SharedWalkthroughCommenting;
  gitIdentity?: GitIdentity | null;
  onDeleteShare?: () => Promise<void> | void;
  snapshot: SharedWalkthroughSnapshot;
}) {
  return (
    <SharedWalkthroughApp
      commenting={commenting}
      gitIdentity={gitIdentity}
      onDeleteShare={onDeleteShare}
      providerLabel="GitHub"
      snapshot={snapshot}
    />
  );
}
