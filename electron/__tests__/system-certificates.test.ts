import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createSystemCertificateTrust } = require('../system-certificates.cjs') as {
  createSystemCertificateTrust: (tlsImpl: {
    getCACertificates?: (source?: string) => Array<string>;
    setDefaultCACertificates?: (certificates: Array<string>) => void;
  }) => () => { reason?: string; status: string };
};

test('merges default, extra, and system certificates once', () => {
  const setDefaultCACertificates = vi.fn();
  const trustSystemCertificates = createSystemCertificateTrust({
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

test('does not mark certificate trust as initialized after a failed apply', () => {
  const setDefaultCACertificates = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('keychain busy');
    })
    .mockImplementationOnce(() => {});
  const trustSystemCertificates = createSystemCertificateTrust({
    getCACertificates: (source) => (source === 'system' ? ['system-ca'] : []),
    setDefaultCACertificates,
  });

  expect(trustSystemCertificates()).toEqual({ reason: 'keychain busy', status: 'failed' });
  expect(trustSystemCertificates()).toEqual({ status: 'applied' });
  expect(setDefaultCACertificates).toHaveBeenCalledTimes(2);
});

test('reports unavailable and empty system certificate stores', () => {
  expect(createSystemCertificateTrust({})()).toEqual({
    reason: 'this Node/Electron runtime does not expose system certificate APIs',
    status: 'unavailable',
  });

  expect(
    createSystemCertificateTrust({
      getCACertificates: () => [],
      setDefaultCACertificates: vi.fn(),
    })(),
  ).toEqual({ reason: 'the system certificate store was empty', status: 'empty-system' });
});
