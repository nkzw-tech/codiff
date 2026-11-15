import { Thinking } from '@nkzw/codiff-core/react';
import { Suspense, type ReactNode } from 'react';

export default function PageSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="codiff-web-page-thinking">
          <Thinking />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
