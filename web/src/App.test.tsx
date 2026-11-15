// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

const auth = vi.hoisted(() => ({
  signIn: {
    social: vi.fn(),
  },
  signOut: vi.fn(),
  useSession: vi.fn(),
}));
const params = vi.hoisted(() => ({ code: 'share-code', slug: 'shared-slug' }));
const suspendedPage = vi.hoisted(() => new Promise<never>(() => {}));

vi.mock('void/client/react', () => ({ auth }));
vi.mock('@void/react', () => ({
  Link: (props: ComponentProps<'a'>) => <a {...props} />,
  useParams: () => params,
}));
vi.mock('./sharing/ConnectPage.tsx', () => ({
  default: () => {
    throw suspendedPage;
  },
}));
vi.mock('./sharing/PlanPage.tsx', () => ({
  default: () => {
    throw suspendedPage;
  },
}));
vi.mock('./sharing/StatsPage.tsx', () => ({
  default: () => <main className="codiff-web-stats">Stats</main>,
}));
vi.mock('./sharing/WalkthroughPage.tsx', () => ({
  default: () => {
    throw suspendedPage;
  },
}));

import ConnectRoute from '../pages/connect/[code].tsx';
import PlanRoute from '../pages/p/[slug].tsx';
import StatsRoute from '../pages/stats.tsx';
import WalkthroughRoute from '../pages/w/[slug].tsx';
import App from './App.tsx';
import PageSuspense from './PageSuspense.tsx';

let container: HTMLDivElement;
let root: Root;

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
};

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({}, '', '/?source=homepage#guide');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  auth.signIn.social.mockReset().mockResolvedValue({});
  auth.signOut.mockReset().mockResolvedValue({});
  auth.useSession.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

test.each([PlanRoute, WalkthroughRoute, ConnectRoute])(
  'uses the shared Thinking state while loading %s',
  async (Page) => {
    auth.useSession.mockReturnValue({ data: null, isPending: false });

    await act(async () =>
      root.render(
        <PageSuspense>
          <Page />
        </PageSuspense>,
      ),
    );

    const loading = container.querySelector('[role="status"]');
    expect(loading?.textContent).toBe('Thinking…');
    expect(loading?.className).toBe('review-source-loading loading pulse italic');
    expect(loading?.parentElement?.className).toBe('codiff-web-page-thinking');
  },
);

test('renders stats inside the standard public shell and header', async () => {
  auth.useSession.mockReturnValue({ data: null, isPending: false });

  await act(async () => root.render(<StatsRoute />));

  expect(container.querySelector('.codiff-web-shell')).not.toBeNull();
  expect(container.querySelector('.codiff-web-header')).not.toBeNull();
  expect(container.querySelector('.codiff-web-stats')?.textContent).toBe('Stats');
});

test('shows the aligned public guide and starts GitHub sign-in from the header', async () => {
  auth.useSession.mockReturnValue({ data: null, isPending: false });

  await act(async () => root.render(<App />));

  expect(container.textContent).toContain('Effective code reviews locally and on the web');
  expect(container.textContent).toContain('$codiff plan');
  expect(container.textContent).toContain('$codiff share');
  expect(container.textContent).toContain('$codiff share pr 131');
  expect(container.textContent).toContain('codiff --share pr 232');
  expect(container.textContent).not.toContain('codiff mr');
  expect(container.textContent).not.toContain('$codiff share mr');
  expect(container.querySelectorAll('button')).toHaveLength(2);
  expect(
    [...container.querySelectorAll('button')].every(
      (button) => button.textContent === 'Continue with GitHub',
    ),
  ).toBe(true);
  const footerCredit = container.querySelector('.codiff-web-footer-credit');
  expect(footerCredit?.textContent).toContain(
    'Created by Nakazawa Tech • Tokens sponsored by Cloudflare & OpenAI',
  );
  expect(footerCredit?.querySelector('.codiff-web-footer-brand')).not.toBeNull();
  expect(container.querySelector('.codiff-web-footer-tagline')).toBeNull();
  const githubLink = container.querySelector<HTMLAnchorElement>('.codiff-web-footer-github');
  expect(githubLink?.href).toBe('https://github.com/nkzw-tech/codiff');
  expect(githubLink?.target).toBe('_blank');
  expect(githubLink?.textContent).toBe('Star on GitHub');

  await click(container.querySelector('button')!);

  expect(auth.signIn.social).toHaveBeenCalledWith({
    callbackURL: '/?source=homepage#guide',
    errorCallbackURL: '/?source=homepage#guide',
    provider: 'github',
  });
});

test('shows the matching authenticated account menu and signs out', async () => {
  auth.useSession.mockReturnValue({
    data: {
      user: {
        image: 'https://example.com/avatar.png',
        name: 'Ada Lovelace',
      },
    },
    isPending: false,
  });

  await act(async () => root.render(<App />));

  expect(container.textContent).not.toContain('Continue with GitHub');
  expect(container.querySelector('.codiff-web-user-name')?.textContent).toBe('Ada Lovelace');
  expect(container.querySelector<HTMLImageElement>('.codiff-web-user-avatar')?.src).toBe(
    'https://example.com/avatar.png',
  );
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  expect(trigger?.getAttribute('aria-label')).toBe('Account menu for Ada Lovelace');

  await click(trigger!);
  const signOut = document.body.querySelector<HTMLElement>('[role="menuitem"]');
  expect(signOut?.textContent).toBe('Sign out');
  await click(signOut!);

  expect(auth.signOut).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toContain('Sign out');
});

test('keeps the account menu open when GitHub sign-out fails', async () => {
  auth.signOut.mockRejectedValue(new Error('Network unavailable.'));
  auth.useSession.mockReturnValue({
    data: {
      user: {
        image: null,
        name: 'Ada Lovelace',
      },
    },
    isPending: false,
  });

  await act(async () => root.render(<App />));
  expect(container.querySelector('.codiff-web-user-avatar-fallback')?.textContent).toBe('AL');

  await click(container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!);
  await click(document.body.querySelector<HTMLElement>('[role="menuitem"]')!);

  expect(document.body.querySelector('[role="menuitem"]')?.textContent).toBe('Sign out');
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
    'Unable to sign out. Try again.',
  );
});
