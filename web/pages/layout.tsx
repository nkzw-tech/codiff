import '@nkzw/codiff-core/styles.css';
import '../src/styles.css';
import { StrictMode, type ReactNode } from 'react';
import { FateClient } from 'react-fate';
import { createFateClient } from 'react-fate/client';
import PageSuspense from '../src/PageSuspense.tsx';

const fate = createFateClient({
  headers: () => {
    const headers = new Headers();
    const secret = new URLSearchParams(window.location.search).get('secret');
    if (secret) {
      headers.set('x-codiff-upload-secret', secret);
    }
    return headers;
  },
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <FateClient client={fate}>
        <PageSuspense>{children}</PageSuspense>
      </FateClient>
    </StrictMode>
  );
}
