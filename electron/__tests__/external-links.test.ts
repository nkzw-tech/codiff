import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { attachExternalLinkHandling } = require('../external-links.cjs') as {
  attachExternalLinkHandling: (
    webContents: FakeWebContents,
    openExternal: (url: string) => Promise<void>,
  ) => void;
};

type WindowOpenHandler = (details: { url: string }) => { action: 'allow' | 'deny' };

type FakeNavigationEvent = { preventDefault: () => void };

type FakeWebContents = {
  getURL: () => string;
  on: (event: string, listener: (event: FakeNavigationEvent, url: string) => void) => void;
  setWindowOpenHandler: (handler: WindowOpenHandler) => void;
};

test('opens target="_blank" links in the default browser instead of an in-app window', () => {
  const { openExternal, openWindow } = createFakeWebContents();

  const result = openWindow('https://github.com/nkzw-tech/codiff/pull/1728');

  expect(result).toEqual({ action: 'deny' });
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(
    'https://github.com/nkzw-tech/codiff/pull/1728',
  );
});

test('denies in-app windows without opening urls the browser should not receive', () => {
  const { openExternal, openWindow } = createFakeWebContents();

  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
    expect(openWindow(url)).toEqual({ action: 'deny' });
  }

  expect(openExternal).not.toHaveBeenCalled();
});

test('redirects external navigation to the default browser', () => {
  const { navigate, openExternal } = createFakeWebContents(
    'file:///Applications/Codiff.app/Contents/Resources/app/web/dist/index.html',
  );

  const event = navigate('https://github.com/nkzw-tech/codiff/pull/1728');

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(
    'https://github.com/nkzw-tech/codiff/pull/1728',
  );
});

test('lets the renderer dev server navigate within its own origin', () => {
  const { navigate, openExternal } = createFakeWebContents('http://127.0.0.1:5173/');

  const event = navigate('http://127.0.0.1:5173/index.html');

  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
});

test('lets the packaged renderer reload its own file url', () => {
  const url = 'file:///Applications/Codiff.app/Contents/Resources/app/web/dist/index.html';
  const { navigate, openExternal } = createFakeWebContents(url);

  const event = navigate(url);

  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
});

test('blocks navigation to other local files without opening anything', () => {
  const { navigate, openExternal } = createFakeWebContents(
    'file:///Applications/Codiff.app/Contents/Resources/app/web/dist/index.html',
  );

  const event = navigate('file:///etc/passwd');

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(openExternal).not.toHaveBeenCalled();
});

function createFakeWebContents(currentUrl = 'http://127.0.0.1:5173/') {
  let windowOpenHandler: WindowOpenHandler | null = null;
  const navigationListeners: Array<(event: FakeNavigationEvent, url: string) => void> = [];
  const openExternal = vi.fn(async () => {});

  const webContents: FakeWebContents = {
    getURL: () => currentUrl,
    on: (event, listener) => {
      if (event === 'will-navigate') {
        navigationListeners.push(listener);
      }
    },
    setWindowOpenHandler: (handler) => {
      windowOpenHandler = handler;
    },
  };
  attachExternalLinkHandling(webContents, openExternal);

  return {
    navigate: (url: string) => {
      const event = { preventDefault: vi.fn() };
      for (const listener of navigationListeners) {
        listener(event, url);
      }
      return event;
    },
    openExternal,
    openWindow: (url: string) => {
      if (!windowOpenHandler) {
        throw new Error('attachExternalLinkHandling did not register a window open handler.');
      }
      return windowOpenHandler({ url });
    },
  };
}
