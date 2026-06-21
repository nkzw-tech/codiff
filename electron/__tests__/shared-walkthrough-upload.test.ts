import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { uploadSharedWalkthrough } = require('../shared-walkthrough-upload.cjs') as {
  uploadSharedWalkthrough: (options: {
    authenticate: () => Promise<void>;
    fetchImpl: typeof fetch;
    openExternal: (url: string) => Promise<void>;
    openClaimPage?: boolean;
    serviceUrl: string;
    snapshot: unknown;
    trustCertificates?: () => { reason?: string; status: string };
    uploader?: { email: string; name: string };
  }) => Promise<string>;
};

test('uploads git identity separately from the walkthrough snapshot', async () => {
  const authenticate = vi.fn(async () => {});
  const requests: Array<{ body?: string | null; credentials?: RequestCredentials; url: string }> =
    [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      body: init?.body as string | null | undefined,
      credentials: init?.credentials,
      url,
    });
    if (url.endsWith('/api/upload-intents')) {
      return Response.json({
        claimUrl: 'https://codiff.example/connect/CODE?secret=secret',
        code: 'CODE',
        pollUrl: 'https://api.codiff.example/api/upload-intents/CODE?secret=secret',
        secret: 'secret',
      });
    }
    if (url.includes('/api/upload-intents/CODE')) {
      return Response.json({ status: 'claimed', uploadToken: 'secret' });
    }
    return Response.json({
      status: 'uploaded',
      url: 'https://codiff.example/w/share',
    });
  });

  const snapshot = { kind: 'codiff-walkthrough-share', version: 1 };
  await expect(
    uploadSharedWalkthrough({
      authenticate,
      fetchImpl,
      openExternal: async () => {},
      serviceUrl: 'https://api.codiff.example',
      snapshot,
      uploader: { email: 'ada@example.com', name: 'Ada Lovelace' },
    }),
  ).resolves.toBe('https://codiff.example/w/share');

  expect(authenticate).toHaveBeenCalledOnce();
  expect(requests.every(({ credentials }) => credentials === 'include')).toBe(true);
  expect(JSON.parse(requests.at(-1)?.body ?? '')).toEqual({
    snapshot,
    uploader: { email: 'ada@example.com', name: 'Ada Lovelace' },
  });
});

test('keeps the public upload payload backward compatible', async () => {
  const requests: Array<{ body?: string | null; url: string }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ body: init?.body as string | null | undefined, url });
    if (url.endsWith('/api/upload-intents')) {
      return Response.json({
        claimUrl: 'https://codiff.example/connect/CODE?secret=secret',
        code: 'CODE',
        pollUrl: 'https://api.codiff.example/api/upload-intents/CODE?secret=secret',
        secret: 'secret',
      });
    }
    if (url.includes('/api/upload-intents/CODE')) {
      return Response.json({ status: 'claimed', uploadToken: 'secret' });
    }
    return Response.json({
      status: 'uploaded',
      url: 'https://codiff.example/w/share',
    });
  });
  const snapshot = { kind: 'codiff-walkthrough-share', version: 1 };

  await uploadSharedWalkthrough({
    authenticate: async () => {},
    fetchImpl,
    openExternal: async () => {},
    serviceUrl: 'https://api.codiff.example',
    snapshot,
  });

  expect(JSON.parse(requests.at(-1)?.body ?? '')).toEqual(snapshot);
});

test('skips the claim page for an immediately claimed headless upload', async () => {
  const openExternal = vi.fn(async () => {});
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/upload-intents')) {
      return Response.json({
        claimUrl: 'https://codiff.example/connect/CODE?secret=secret',
        code: 'CODE',
        pollUrl: 'https://codiff.example/api/upload-intents/CODE?secret=secret',
        secret: 'secret',
        status: 'claimed',
      });
    }
    return Response.json({
      status: 'uploaded',
      url: 'https://codiff.example/w/share',
    });
  });

  await expect(
    uploadSharedWalkthrough({
      authenticate: async () => {},
      fetchImpl,
      openClaimPage: false,
      openExternal,
      serviceUrl: 'https://codiff.example',
      snapshot: { kind: 'codiff-walkthrough-share', version: 1 },
    }),
  ).resolves.toBe('https://codiff.example/w/share');

  expect(openExternal).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test('includes the underlying cause when a share request cannot connect', async () => {
  const networkError = new Error('fetch failed', {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.codiff.dev'), {
      code: 'ENOTFOUND',
    }),
  });

  await expect(
    uploadSharedWalkthrough({
      authenticate: async () => {},
      fetchImpl: vi.fn(async () => {
        throw networkError;
      }),
      openExternal: async () => {},
      serviceUrl: 'https://api.codiff.dev',
      snapshot: { kind: 'codiff-walkthrough-share', version: 1 },
    }),
  ).rejects.toThrow(
    'Codiff share upload intent request failed: fetch failed: ENOTFOUND - getaddrinfo ENOTFOUND api.codiff.dev',
  );
});

test('loads certificate trust before the first share request', async () => {
  const events: Array<string> = [];
  const trustCertificates = vi.fn(() => {
    events.push('certificates');
    return { status: 'applied' };
  });
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    events.push(String(input));
    return Response.json({
      claimUrl: 'https://codiff.example/connect/CODE?secret=secret',
      code: 'CODE',
      pollUrl: 'https://codiff.example/api/upload-intents/CODE?secret=secret',
      secret: 'secret',
      status: 'claimed',
    });
  });

  await expect(
    uploadSharedWalkthrough({
      authenticate: async () => {},
      fetchImpl,
      openClaimPage: false,
      openExternal: async () => {},
      serviceUrl: 'https://codiff.example',
      snapshot: { kind: 'codiff-walkthrough-share', version: 1 },
      trustCertificates,
    }),
  ).rejects.toThrow('Codiff share upload failed (200).');

  expect(trustCertificates).toHaveBeenCalledOnce();
  expect(events[0]).toBe('certificates');
  expect(events[1]).toBe('https://codiff.example/api/upload-intents');
});

test('explains certificate trust status for certificate-chain failures', async () => {
  const certificateError = new Error('self signed certificate in certificate chain');
  Object.assign(certificateError, { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  const networkError = new Error('fetch failed', { cause: certificateError });

  await expect(
    uploadSharedWalkthrough({
      authenticate: async () => {},
      fetchImpl: vi.fn(async () => {
        throw networkError;
      }),
      openExternal: async () => {},
      serviceUrl: 'https://api.codiff.dev',
      snapshot: { kind: 'codiff-walkthrough-share', version: 1 },
      trustCertificates: () => ({
        reason: 'this Node/Electron runtime does not expose system certificate APIs',
        status: 'unavailable',
      }),
    }),
  ).rejects.toThrow(
    'Codiff share upload intent request failed: fetch failed: SELF_SIGNED_CERT_IN_CHAIN - self signed certificate in certificate chain System certificate trust was not applied (this Node/Electron runtime does not expose system certificate APIs).',
  );
});
