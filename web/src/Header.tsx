import { Menu } from '@base-ui/react/menu';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { Link } from '@void/react';
import { useEffect, useState } from 'react';
import { auth } from 'void/client/react';
import icon from './assets/icon.webp';
import SignInButton from './SignInButton.tsx';

const getNameParts = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map((part) => [...part].filter((character) => /[\p{L}\p{N}]/u.test(character)).join(''))
    .filter(Boolean);

const getInitial = (part: string) => [...part][0]?.toLocaleUpperCase() ?? '';

const getAvatarInitials = (name: string) => {
  const parts = getNameParts(name);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    return [...parts[0]].slice(0, 2).join('').toLocaleUpperCase();
  }
  return `${getInitial(parts[0])}${getInitial(parts.at(-1) ?? '')}` || '?';
};

const useAvatarPreload = (url: null | string | undefined) => {
  useEffect(() => {
    if (!url) {
      return;
    }

    const link = document.createElement('link');
    link.setAttribute('data-codiff-image-preload', 'authenticated-user-avatar');
    link.rel = 'preload';
    link.as = 'image';
    link.href = url;
    document.head.append(link);
    return () => link.remove();
  }, [url]);
};

export default function Header() {
  const { data: session, isPending } = auth.useSession();
  useAvatarPreload(session?.user.image);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOut = () => {
    setIsSigningOut(true);
    setSignOutError(null);
    auth.signOut().then(
      () => {
        setIsSigningOut(false);
        setAccountMenuOpen(false);
      },
      () => {
        setIsSigningOut(false);
        setSignOutError('Unable to sign out. Try again.');
      },
    );
  };

  return (
    <header className="codiff-web-header">
      <div className="codiff-web-header-inner">
        <Link className="codiff-web-brand" href="/">
          <img alt="" className="codiff-web-brand-icon" draggable={false} src={icon} />
          <span>Codiff</span>
        </Link>
        {isPending ? (
          <div aria-hidden className="codiff-web-header-spacer">
            <SignInButton />
          </div>
        ) : session?.user ? (
          <Menu.Root
            onOpenChange={(open) => {
              setAccountMenuOpen(open);
              if (open) {
                setSignOutError(null);
              }
            }}
            open={accountMenuOpen}
          >
            <Menu.Trigger
              aria-label={`Account menu for ${session.user.name}`}
              className="codiff-web-user-menu-trigger"
            >
              {session.user.image ? (
                <img
                  alt=""
                  className="codiff-web-user-avatar"
                  draggable={false}
                  src={session.user.image}
                />
              ) : (
                <span
                  aria-hidden
                  className="codiff-web-user-avatar codiff-web-user-avatar-fallback"
                >
                  {getAvatarInitials(session.user.name)}
                </span>
              )}
              <span className="codiff-web-user-name">{session.user.name}</span>
              <CaretDown
                aria-hidden
                className="codiff-web-user-menu-chevron"
                size={14}
                weight="bold"
              />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                align="end"
                className="codiff-web-user-menu-positioner"
                sideOffset={8}
              >
                <Menu.Popup className="codiff-web-user-menu-popup">
                  <Menu.Item
                    className="codiff-web-user-menu-item"
                    closeOnClick={false}
                    disabled={isSigningOut}
                    onClick={signOut}
                  >
                    {isSigningOut ? 'Signing out…' : 'Sign out'}
                  </Menu.Item>
                  {signOutError ? (
                    <p className="codiff-web-user-menu-error" role="alert">
                      {signOutError}
                    </p>
                  ) : null}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        ) : (
          <SignInButton />
        )}
      </div>
    </header>
  );
}
