import { Button } from '@nkzw/codiff-core/react';
import type { ReactNode } from 'react';
import { auth } from 'void/client/react';

export default function SignInButton({
  children = 'Continue with GitHub',
  size = 'sm',
  variant = 'outline',
}: {
  children?: ReactNode;
  size?: 'default' | 'lg' | 'sm';
  variant?: 'default' | 'outline';
}) {
  return (
    <Button
      action={() =>
        auth.signIn.social({
          callbackURL: window.location.pathname + window.location.search + window.location.hash,
          errorCallbackURL:
            window.location.pathname + window.location.search + window.location.hash,
          provider: 'github',
        })
      }
      pendingPlaceholder={children}
      size={size}
      variant={variant}
    >
      {children}
    </Button>
  );
}
