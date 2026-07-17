import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const tls = require('node:tls') as {
  getCACertificates?: (source?: string) => Array<string>;
  setDefaultCACertificates?: (certificates: Array<string>) => void;
};
const modulePath = require.resolve('../system-certificates.cjs');

const loadTrustSystemCertificates = (tlsImpl: typeof tls) => {
  const originalGetCACertificates = tls.getCACertificates;
  const originalSetDefaultCACertificates = tls.setDefaultCACertificates;
  tls.getCACertificates = tlsImpl.getCACertificates;
  tls.setDefaultCACertificates = tlsImpl.setDefaultCACertificates;
  delete require.cache[modulePath];
  const { trustSystemCertificates } = require(modulePath) as {
    trustSystemCertificates: () => { reason?: string; status: string };
  };

  return {
    restore: () => {
      tls.getCACertificates = originalGetCACertificates;
      tls.setDefaultCACertificates = originalSetDefaultCACertificates;
      delete require.cache[modulePath];
    },
    trustSystemCertificates,
  };
};

test.sequential('merges default, extra, and system certificates once', () => {
  const setDefaultCACertificates = vi.fn();
  const { restore, trustSystemCertificates } = loadTrustSystemCertificates({
    getCACertificates: (source) => {
      if (source === 'default') {
        return ['default-ca', 'shared-ca'];
      }
      if (source === 'extra') {
        return ['extra-ca', 'shared-ca'];
      }
      if (source === 'system') {
        return ['system-ca', 'extra-ca'];
      }
      return [];
    },
    setDefaultCACertificates,
  });
  using _cleanup = {
    [Symbol.dispose]() {
      restore();
    },
  };

  expect(trustSystemCertificates()).toEqual({ status: 'applied' });
  expect(trustSystemCertificates()).toEqual({ status: 'applied' });
  expect(setDefaultCACertificates).toHaveBeenCalledOnce();
  expect(setDefaultCACertificates).toHaveBeenCalledWith([
    'default-ca',
    'shared-ca',
    'extra-ca',
    'system-ca',
  ]);
});

test.sequential('does not mark certificate trust as initialized after a failed apply', () => {
  const setDefaultCACertificates = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('keychain busy');
    })
    .mockImplementationOnce(() => {});
  const { restore, trustSystemCertificates } = loadTrustSystemCertificates({
    getCACertificates: (source) => (source === 'system' ? ['system-ca'] : []),
    setDefaultCACertificates,
  });
  using _cleanup = {
    [Symbol.dispose]() {
      restore();
    },
  };

  expect(trustSystemCertificates()).toEqual({ reason: 'keychain busy', status: 'failed' });
  expect(trustSystemCertificates()).toEqual({ status: 'applied' });
  expect(setDefaultCACertificates).toHaveBeenCalledTimes(2);
});

test.sequential('reports unavailable and empty system certificate stores', () => {
  const unavailable = loadTrustSystemCertificates({});
  using _unavailableCleanup = {
    [Symbol.dispose]() {
      unavailable.restore();
    },
  };
  expect(unavailable.trustSystemCertificates()).toEqual({
    reason: 'this Node/Electron runtime does not expose system certificate APIs',
    status: 'unavailable',
  });

  const empty = loadTrustSystemCertificates({
    getCACertificates: () => [],
    setDefaultCACertificates: vi.fn(),
  });
  using _emptyCleanup = {
    [Symbol.dispose]() {
      empty.restore();
    },
  };
  expect(empty.trustSystemCertificates()).toEqual({
    reason: 'the system certificate store was empty',
    status: 'empty-system',
  });
});
