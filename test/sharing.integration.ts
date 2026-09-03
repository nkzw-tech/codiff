/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import { handleSharingApiRequest, type SharingBucket, type SharingEnv } from '../service/api.ts';
import { hashUploadIntentSecret } from '../service/upload-intent.ts';

const origin = 'https://test.codiff.local';

const planSnapshot = {
  codiffVersion: '1.8.0',
  document: {
    content: '# Ship public sharing\n\n- Keep uploads authenticated\n',
    name: 'plan.md',
    title: 'Ship public sharing',
  },
  exportedAt: '2026-07-16T00:00:00.000Z',
  kind: 'codiff-plan-share',
  preferences: { theme: 'system' },
  review: {
    threads: [
      {
        anchor: {
          block: {
            fingerprint: 'ship-public-sharing',
            path: [0],
            text: 'Ship public sharing',
            type: 'heading',
          },
          kind: 'block',
          version: 1,
        },
        createdAt: '2026-07-15T00:00:00.000Z',
        createdBy: { id: 'reviewer', name: 'Reviewer' },
        id: 'imported-plan-thread',
        messages: [
          {
            author: { id: 'reviewer', name: 'Reviewer', username: 'reviewer' },
            body: 'This imported comment should remain read-only.',
            createdAt: '2026-07-15T00:00:00.000Z',
            id: 'imported-plan-message',
            updatedAt: '2026-07-15T01:00:00.000Z',
          },
        ],
        resolution: {
          reason: 'agent-handled',
          resolvedAt: '2026-07-15T01:00:00.000Z',
        },
        status: 'resolved',
        updatedAt: '2026-07-15T01:00:00.000Z',
      },
    ],
    version: 1,
  },
  source: {
    agent: 'codex',
    sessionId: 'integration-session',
  },
  version: 1,
} as const;

const walkthroughSnapshot = {
  branch: 'feature/public-sharing',
  codiffVersion: '1.8.0',
  exportedAt: '2026-07-16T00:00:00.000Z',
  files: [{ path: 'src/review.ts', status: 'modified' }],
  kind: 'codiff-walkthrough-share',
  repository: {
    generalComments: [
      {
        comments: [
          {
            author: { login: 'grace', name: 'Grace Hopper' },
            body: 'Imported general context.',
            id: 'general-message',
            submittedAt: '2026-07-15T00:30:00.000Z',
          },
        ],
        id: 'general-thread',
      },
    ],
    root: '/private/source/path',
    source: {
      host: 'github.com',
      number: 42,
      projectPath: 'codiff/codiff',
      provider: 'github',
      title: 'Ship public sharing',
      type: 'pull-request',
      url: 'https://github.com/codiff/codiff/pull/42',
    },
  },
  reviewComments: [
    {
      author: { login: 'grace', name: 'Grace Hopper' },
      body: 'First imported diff comment.',
      filePath: 'src/review.ts',
      id: 'diff-message-1',
      lineNumber: 1,
      side: 'additions',
      submittedAt: '2026-07-15T00:00:00.000Z',
      threadId: 'diff-thread',
    },
    {
      author: { login: 'linus', name: 'Linus Torvalds' },
      body: 'Imported reply.',
      filePath: 'src/review.ts',
      id: 'diff-message-2',
      lineNumber: 1,
      side: 'additions',
      submittedAt: '2026-07-15T00:10:00.000Z',
      threadId: 'diff-thread',
    },
    {
      anchor: 'file',
      author: { login: 'margaret', name: 'Margaret Hamilton' },
      body: 'Imported file comment.',
      filePath: 'src/review.ts',
      id: 'file-message',
      submittedAt: '2026-07-15T00:20:00.000Z',
    },
  ],
  version: 1,
  walkthrough: {
    chapters: [],
    summary: 'An integration-test walkthrough.',
    title: 'Public sharing walkthrough',
  },
} as const;

type GitHubProfile = {
  avatarUrl: string;
  email: string;
  id: number;
  login: string;
  name: string;
};

type UploadIntent = {
  code: string;
  pollUrl: string;
  secret: string;
  status: 'claimed' | 'pending';
};

const ada: GitHubProfile = {
  avatarUrl: 'https://avatars.example/ada.png',
  email: 'ada@example.com',
  id: 42,
  login: 'ada',
  name: 'Ada Lovelace',
};

const grace: GitHubProfile = {
  avatarUrl: 'https://avatars.example/grace.png',
  email: 'grace@example.com',
  id: 43,
  login: 'grace',
  name: 'Grace Hopper',
};

const readJson = async <Value>(response: Response) => (await response.json()) as Value;

const readCookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const clearState = async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ShareCommentMessage'),
    env.DB.prepare('DELETE FROM ShareCommentThread'),
    env.DB.prepare('DELETE FROM WalkthroughFile'),
    env.DB.prepare('DELETE FROM Plan'),
    env.DB.prepare('DELETE FROM Walkthrough'),
    env.DB.prepare('DELETE FROM UploadIntent'),
    env.DB.prepare('DELETE FROM ShareDailyUsage'),
    env.DB.prepare('DELETE FROM session'),
    env.DB.prepare('DELETE FROM account'),
    env.DB.prepare('DELETE FROM verification'),
    env.DB.prepare('DELETE FROM user'),
  ]);
  const objects = await env.WALKTHROUGH_BUCKET.list();
  await Promise.all(
    objects.objects.map(({ key }: { key: string }) => env.WALKTHROUGH_BUCKET.delete(key)),
  );
};

let activeGitHubProfile = ada;

const installGitHubMock = () => {
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
        return Response.json({
          access_token: `access-token-${activeGitHubProfile.login}`,
          scope: 'read:user,user:email',
          token_type: 'bearer',
        });
      }
      if (url.origin === 'https://api.github.com' && url.pathname === '/user') {
        return Response.json({
          avatar_url: activeGitHubProfile.avatarUrl,
          email: activeGitHubProfile.email,
          id: activeGitHubProfile.id,
          login: activeGitHubProfile.login,
          name: activeGitHubProfile.name,
        });
      }
      if (url.origin === 'https://api.github.com' && url.pathname === '/user/emails') {
        return Response.json([
          {
            email: activeGitHubProfile.email,
            primary: true,
            verified: true,
            visibility: 'private',
          },
        ]);
      }
      return nativeFetch(input, init);
    },
  );
};

const signInWithGitHub = async (profile: GitHubProfile, callbackURL = '/') => {
  activeGitHubProfile = profile;
  const signInResponse = await SELF.fetch(`${origin}/api/auth/sign-in/social`, {
    body: JSON.stringify({ callbackURL, provider: 'github' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  expect(signInResponse.status).toBe(200);

  const signIn = await readJson<{ redirect: boolean; url: string }>(signInResponse);
  const authorizationUrl = new URL(signIn.url);
  expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
    'https://github.com/login/oauth/authorize',
  );
  expect(authorizationUrl.searchParams.get('client_id')).toBe('test-github-client-id');
  expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
    `${origin}/api/auth/callback/github`,
  );

  const callbackResponse = await SELF.fetch(
    `${origin}/api/auth/callback/github?code=integration-code&state=${authorizationUrl.searchParams.get('state')}`,
    {
      headers: { cookie: readCookies(signInResponse) },
      redirect: 'manual',
    },
  );
  expect(callbackResponse.status).toBe(302);
  expect(callbackResponse.headers.get('location')).toBe(callbackURL);
  return readCookies(callbackResponse);
};

const createIntent = async (cookie?: string) => {
  const response = await SELF.fetch(`${origin}/api/upload-intents`, {
    headers: cookie ? { cookie } : undefined,
    method: 'POST',
  });
  return { response, value: await readJson<UploadIntent & { resetAt?: string }>(response) };
};

const fateOperation = async (
  operation: Record<string, unknown>,
  options: { cookie?: string; secret?: string } = {},
) =>
  readJson<{
    results: Array<{
      data?: Record<string, unknown>;
      error?: { code: string; message?: string };
      id: string;
      ok: boolean;
    }>;
    version: number;
  }>(
    await SELF.fetch(`${origin}/fate`, {
      body: JSON.stringify({ operations: [operation], version: 1 }),
      headers: {
        'content-type': 'application/json',
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.secret ? { 'x-codiff-upload-secret': options.secret } : {}),
      },
      method: 'POST',
    }),
  );

const claimIntent = async (intent: UploadIntent, cookie: string) => {
  const result = await fateOperation(
    {
      args: { code: intent.code },
      id: 'claim-upload-intent',
      kind: 'query',
      name: 'uploadIntentByCode',
      select: ['expiresAt', 'id', 'shareKind', 'status', 'walkthroughSlug'],
    },
    { cookie, secret: intent.secret },
  );
  expect(result.results[0]).toMatchObject({
    data: {
      id: expect.any(String),
      status: 'claimed',
      walkthroughSlug: null,
    },
    ok: true,
  });
  return result.results[0]!.data as {
    id: string;
    status: string;
    walkthroughSlug: null | string;
  };
};

const uploadShare = async (intent: UploadIntent, snapshot: unknown) =>
  SELF.fetch(`${origin}/api/uploads`, {
    body: JSON.stringify({
      snapshot,
      uploader: {
        email: 'private-uploader@example.com',
        name: 'Private Uploader',
      },
    }),
    headers: {
      authorization: `Bearer ${intent.secret}`,
      'content-type': 'application/json',
      'x-codiff-upload-code': intent.code,
    },
    method: 'POST',
  });

const createAndUpload = async (
  cookie: string,
  kind: 'plan' | 'walkthrough',
): Promise<{ id: string; slug: string }> => {
  const { response, value: intent } = await createIntent(cookie);
  expect(response.status).toBe(200);
  expect(intent.status).toBe('claimed');
  const uploadResponse = await uploadShare(
    intent,
    kind === 'plan' ? planSnapshot : walkthroughSnapshot,
  );
  expect(uploadResponse.status).toBe(200);
  const upload = await readJson<{ slug: string }>(uploadResponse);
  const table = kind === 'plan' ? 'Plan' : 'Walkthrough';
  const record = await env.DB.prepare(`SELECT id FROM ${table} WHERE slug = ?`)
    .bind(upload.slug)
    .first<{ id: string }>();
  if (!record) {
    throw new Error(`Expected the ${kind} share to be stored.`);
  }
  return { id: record.id, slug: upload.slug };
};

const mutate = (
  name: string,
  input: Record<string, unknown>,
  cookie: string | undefined,
  select: Array<string>,
) =>
  fateOperation(
    {
      id: name,
      input,
      kind: 'mutation',
      name,
      select,
    },
    { cookie },
  );

const setUsage = async (userId: string, planCount: number, walkthroughCount: number) => {
  await env.DB.prepare(
    `INSERT INTO ShareDailyUsage (date, planCount, userId, walkthroughCount)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (userId, date) DO UPDATE SET
       planCount = excluded.planCount,
       walkthroughCount = excluded.walkthroughCount`,
  )
    .bind(new Date().toISOString().slice(0, 10), planCount, userId, walkthroughCount)
    .run();
};

beforeEach(async () => {
  await clearState();
  activeGitHubProfile = ada;
  installGitHubMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('requires GitHub authentication before an upload intent can persist or be claimed', async () => {
  const { response, value: intent } = await createIntent();
  expect(response.status).toBe(200);
  expect(intent).toMatchObject({
    code: expect.any(String),
    pollUrl: expect.stringContaining(`/api/upload-intents/${intent.code}`),
    secret: expect.any(String),
    status: 'pending',
  });
  expect(
    await env.DB.prepare('SELECT id FROM UploadIntent WHERE code = ?').bind(intent.code).first(),
  ).toBeNull();
  expect(await readJson(await SELF.fetch(intent.pollUrl))).toEqual({ status: 'pending' });
  expect((await uploadShare(intent, planSnapshot)).status).toBe(401);
  expect((await env.WALKTHROUGH_BUCKET.list()).objects).toHaveLength(0);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM Plan').first()).toEqual({ count: 0 });

  const anonymousClaim = await fateOperation(
    {
      args: { code: intent.code },
      id: 'anonymous-claim',
      kind: 'query',
      name: 'uploadIntentByCode',
      select: ['id', 'status'],
    },
    { secret: intent.secret },
  );
  expect(anonymousClaim.results[0]).toMatchObject({
    error: { code: 'UNAUTHORIZED' },
    ok: false,
  });
  expect(
    await env.DB.prepare('SELECT id FROM UploadIntent WHERE code = ?').bind(intent.code).first(),
  ).toBeNull();

  const ownerCookie = await signInWithGitHub(ada, '/connect/integration');
  const session = await readJson<{
    user: {
      displayUsername: string;
      email: string;
      name: string;
      username: string;
    };
  }>(
    await SELF.fetch(`${origin}/api/auth/get-session`, {
      headers: { cookie: ownerCookie },
    }),
  );
  expect(session.user).toMatchObject({
    displayUsername: 'ada',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    username: 'ada',
  });

  const claimed = await claimIntent(intent, ownerCookie);
  expect(await readJson(await SELF.fetch(intent.pollUrl))).toEqual({
    status: 'claimed',
    uploadToken: intent.secret,
  });
  const stored = await env.DB.prepare(
    `SELECT UploadIntent.sharedByUserId, user.username
     FROM UploadIntent
     JOIN user ON user.id = UploadIntent.sharedByUserId
     WHERE UploadIntent.id = ?`,
  )
    .bind(claimed.id)
    .first();
  expect(stored).toEqual({
    sharedByUserId: expect.any(String),
    username: 'ada',
  });

  const otherCookie = await signInWithGitHub(grace, '/connect/integration');
  const otherAccountClaim = await fateOperation(
    {
      args: { code: intent.code },
      id: 'other-account-claim',
      kind: 'query',
      name: 'uploadIntentByCode',
      select: ['id', 'status'],
    },
    { cookie: otherCookie, secret: intent.secret },
  );
  expect(otherAccountClaim.results[0]).toMatchObject({
    error: { code: 'FORBIDDEN' },
    ok: false,
  });

  expect(
    await SELF.fetch(`${origin}/api/upload-intents/${intent.code}?secret=tampered`),
  ).toMatchObject({ status: 404 });
});

test('stores immutable plan and walkthrough shares through D1, R2, Fate, and polling', async () => {
  const cookie = await signInWithGitHub(ada);

  for (const kind of ['plan', 'walkthrough'] as const) {
    const { value: intent } = await createIntent(cookie);
    const uploadResponse = await uploadShare(
      intent,
      kind === 'plan' ? planSnapshot : walkthroughSnapshot,
    );
    expect(uploadResponse.status).toBe(200);
    const upload = await readJson<{ slug: string; status: string; url: string }>(uploadResponse);
    expect(upload).toEqual({
      slug: expect.any(String),
      status: 'uploaded',
      url: `${origin}/${kind === 'plan' ? 'p' : 'w'}/${upload.slug}`,
    });

    const table = kind === 'plan' ? 'Plan' : 'Walkthrough';
    const stored = await env.DB.prepare(
      `SELECT objectKey, sharedByEmail, sharedByName, sharedByUserId, slug, title
       FROM ${table} WHERE slug = ?`,
    )
      .bind(upload.slug)
      .first<{
        objectKey: string;
        sharedByEmail: null | string;
        sharedByName: null | string;
        sharedByUserId: string;
        slug: string;
        title: string;
      }>();
    expect(stored).toMatchObject({
      sharedByEmail: null,
      sharedByName: null,
      sharedByUserId: expect.any(String),
      slug: upload.slug,
      title: kind === 'plan' ? 'Ship public sharing' : 'Public sharing walkthrough',
    });
    if (!stored) {
      throw new Error(`Expected the ${kind} metadata.`);
    }

    const object = await env.WALKTHROUGH_BUCKET.get(stored.objectKey);
    expect(object).not.toBeNull();
    const canonicalSnapshot = await object!.json<Record<string, unknown>>();
    if (kind === 'walkthrough') {
      expect(canonicalSnapshot).toMatchObject({
        repository: { root: 'Shared Codiff review' },
      });
      expect(canonicalSnapshot).not.toMatchObject({
        repository: { root: '/private/source/path' },
      });
    } else {
      expect(canonicalSnapshot).toEqual(planSnapshot);
    }

    const fateResult = await fateOperation({
      args: { slug: upload.slug },
      id: kind,
      kind: 'query',
      name: kind === 'plan' ? 'planBySlug' : 'walkthroughBySlug',
      select: ['id', 'slug', 'title'],
    });
    expect(fateResult.results[0]).toMatchObject({
      data: {
        id: expect.any(String),
        slug: upload.slug,
        title: kind === 'plan' ? 'Ship public sharing' : 'Public sharing walkthrough',
      },
      ok: true,
    });

    const manifestResponse = await SELF.fetch(
      `${origin}/api/${kind === 'plan' ? 'plans' : 'walkthroughs'}/${upload.slug}/manifest`,
    );
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get('cache-control')).toBe('no-store');
    expect(manifestResponse.headers.get('x-robots-tag')).toBe('noindex');
    expect(await manifestResponse.json()).toEqual(canonicalSnapshot);
    expect(await readJson(await SELF.fetch(intent.pollUrl))).toEqual({
      status: 'uploaded',
      url: upload.url,
    });

    const repeatedUpload = await uploadShare(intent, canonicalSnapshot);
    expect(repeatedUpload.status).toBe(401);
  }
});

test('accepts only one concurrent upload for an intent', async () => {
  const cookie = await signInWithGitHub(ada);
  const { value: intent } = await createIntent(cookie);

  const responses = await Promise.all([
    uploadShare(intent, planSnapshot),
    uploadShare(intent, planSnapshot),
  ]);
  expect(responses.map((response: Response) => response.status).sort()).toEqual([200, 401]);

  const successful = responses.find((response: Response) => response.status === 200);
  if (!successful) {
    throw new Error('Expected one upload to succeed.');
  }
  const upload = await readJson<{ slug: string }>(successful);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM Plan').first()).toEqual({ count: 1 });
  expect(
    await env.DB.prepare('SELECT status, walkthroughSlug FROM UploadIntent WHERE code = ?')
      .bind(intent.code)
      .first(),
  ).toEqual({ status: 'uploaded', walkthroughSlug: upload.slug });
  expect((await env.WALKTHROUGH_BUCKET.list()).objects).toHaveLength(1);
});

test('enforces per-kind and combined daily quotas and rolls R2 back on a D1 quota race', async () => {
  const cookie = await signInWithGitHub(ada);
  const owner = await env.DB.prepare('SELECT id FROM user WHERE email = ?')
    .bind(ada.email)
    .first<{ id: string }>();
  if (!owner) {
    throw new Error('Expected the authenticated user.');
  }

  await setUsage(owner.id, 50, 0);
  const planIntent = (await createIntent(cookie)).value;
  const rejectedPlan = await uploadShare(planIntent, planSnapshot);
  expect(rejectedPlan.status).toBe(429);
  expect(await readJson(rejectedPlan)).toMatchObject({
    error: 'share-quota-exceeded',
    resetAt: expect.stringMatching(/T00:00:00\.000Z$/),
  });
  expect(Number(rejectedPlan.headers.get('retry-after'))).toBeGreaterThan(0);

  await setUsage(owner.id, 0, 50);
  const walkthroughIntent = (await createIntent(cookie)).value;
  const rejectedWalkthrough = await uploadShare(walkthroughIntent, walkthroughSnapshot);
  expect(rejectedWalkthrough.status).toBe(429);
  expect(
    await env.DB.prepare('SELECT status FROM UploadIntent WHERE code IN (?, ?) ORDER BY code')
      .bind(planIntent.code, walkthroughIntent.code)
      .all(),
  ).toMatchObject({
    results: [{ status: 'claimed' }, { status: 'claimed' }],
  });
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM Plan').first()).toEqual({ count: 0 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM Walkthrough').first()).toEqual({
    count: 0,
  });

  await setUsage(owner.id, 49, 50);
  const lastAllowedIntent = (await createIntent(cookie)).value;
  expect((await uploadShare(lastAllowedIntent, planSnapshot)).status).toBe(200);
  const exhausted = await createIntent(cookie);
  expect(exhausted.response.status).toBe(429);
  expect(exhausted.value).toMatchObject({
    resetAt: expect.stringMatching(/T00:00:00\.000Z$/),
  });
  expect(Number(exhausted.response.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(
    await env.DB.prepare('SELECT planCount, walkthroughCount FROM ShareDailyUsage WHERE userId = ?')
      .bind(owner.id)
      .first(),
  ).toEqual({ planCount: 50, walkthroughCount: 50 });

  const rollbackSecret = 'rollback-secret';
  const rollbackCode = 'ROLLBACK01';
  const rollbackIntentId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO UploadIntent (
      claimedAt, code, expiresAt, id, secretHash, sharedByUserId, status, updatedAt, uploadTokenHash
    ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
  )
    .bind(
      Math.floor(Date.now() / 1000),
      rollbackCode,
      Math.floor(Date.now() / 1000) + 600,
      rollbackIntentId,
      await hashUploadIntentSecret(rollbackSecret),
      owner.id,
      Math.floor(Date.now() / 1000),
      await hashUploadIntentSecret(rollbackSecret),
    )
    .run();
  await setUsage(owner.id, 50, 0);

  let putKey: null | string = null;
  let deletedKey: null | string = null;
  const bucket: SharingBucket = {
    delete: async (key) => {
      deletedKey = key;
      return env.WALKTHROUGH_BUCKET.delete(key);
    },
    get: async (key) => env.WALKTHROUGH_BUCKET.get(key),
    put: async (key, value, options) => {
      putKey = key;
      return env.WALKTHROUGH_BUCKET.put(key, value, options);
    },
  };
  const rollbackResponse = await handleSharingApiRequest(
    new Request(`${origin}/api/uploads`, {
      body: JSON.stringify({ snapshot: planSnapshot }),
      headers: {
        authorization: `Bearer ${rollbackSecret}`,
        'content-type': 'application/json',
        'x-codiff-upload-code': rollbackCode,
      },
      method: 'POST',
    }),
    {
      BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32-characters',
      DB: env.DB,
      PUBLIC_ORIGIN: origin,
      WALKTHROUGH_BUCKET: bucket,
    } satisfies SharingEnv,
    { enforceDailyQuota: false },
  );
  expect(rollbackResponse.status).toBe(429);
  expect(putKey).toEqual(expect.any(String));
  expect(deletedKey).toBe(putKey);
  expect(await env.WALKTHROUGH_BUCKET.get(putKey!)).toBeNull();
  expect(
    await env.DB.prepare('SELECT status, walkthroughSlug FROM UploadIntent WHERE id = ?')
      .bind(rollbackIntentId)
      .first(),
  ).toEqual({ status: 'claimed', walkthroughSlug: null });
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS count FROM Plan WHERE objectKey = ?')
      .bind(putKey)
      .first(),
  ).toEqual({ count: 0 });
});

test('enforces comment authentication, message ownership, and share-owner resolution', async () => {
  const ownerCookie = await signInWithGitHub(ada);
  const commenterCookie = await signInWithGitHub(grace);
  const sharedPlan = await createAndUpload(ownerCookie, 'plan');

  const queryComments = (cookie?: string) =>
    fateOperation(
      {
        args: { slug: sharedPlan.slug },
        id: 'plan-comments',
        kind: 'query',
        name: 'planBySlug',
        select: [
          'canResolveComments',
          'commentThreads.id',
          'commentThreads.messages.body',
          'commentThreads.messages.canEdit',
          'commentThreads.messages.id',
          'commentThreads.status',
          'id',
        ],
      },
      { cookie },
    );

  const [firstImport, secondImport] = await Promise.all([queryComments(), queryComments()]);
  expect(firstImport.results[0]).toMatchObject({
    data: {
      canResolveComments: false,
      commentThreads: {
        items: [
          {
            node: {
              messages: {
                items: [
                  {
                    node: {
                      body: 'This imported comment should remain read-only.',
                      canEdit: false,
                    },
                  },
                ],
              },
              status: 'resolved',
            },
          },
        ],
      },
    },
    ok: true,
  });
  expect(secondImport.results[0]?.ok).toBe(true);
  expect(
    await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM ShareCommentThread WHERE planId = ?) AS threads,
        (SELECT COUNT(*) FROM ShareCommentMessage
         WHERE threadId IN (SELECT id FROM ShareCommentThread WHERE planId = ?)) AS messages`,
    )
      .bind(sharedPlan.id, sharedPlan.id)
      .first(),
  ).toEqual({ messages: 1, threads: 1 });

  const createInput = {
    body: 'A comment from Grace.',
    shareId: sharedPlan.id,
    shareType: 'plan',
    target: {
      anchor: {
        block: {
          fingerprint: 'ship-public-sharing',
          path: [0],
          text: 'Ship public sharing',
          type: 'heading',
        },
        kind: 'block',
        version: 1,
      },
      kind: 'plan',
    },
  };
  const created = await mutate('shareComment.createThread', createInput, commenterCookie, [
    'id',
    'messages.body',
    'messages.canEdit',
    'messages.id',
  ]);
  expect(created.results[0]).toMatchObject({
    data: {
      messages: {
        items: [{ node: { body: 'A comment from Grace.', canEdit: true } }],
      },
    },
    ok: true,
  });
  const createdThread = created.results[0]?.data as
    | {
        id: string;
        messages: { items: Array<{ node: { id: string } }> };
      }
    | undefined;
  const threadId = createdThread?.id;
  const messageId = createdThread?.messages.items[0]?.node.id;
  if (!threadId || !messageId) {
    throw new Error('Expected a persisted comment thread.');
  }

  const countsBeforeAnonymousMutations = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM ShareCommentThread) AS threads,
      (SELECT COUNT(*) FROM ShareCommentMessage) AS messages`,
  ).first();
  const anonymousMutations = [
    mutate('shareComment.createThread', createInput, undefined, ['id']),
    mutate('shareComment.reply', { body: 'Anonymous reply.', threadId }, undefined, ['id']),
    mutate('shareComment.updateMessage', { body: 'Anonymous edit.', messageId }, undefined, ['id']),
    mutate('shareComment.deleteMessage', { id: messageId }, undefined, ['id']),
    mutate('shareComment.resolveThread', { resolved: true, threadId }, undefined, ['id']),
  ];
  for (const result of await Promise.all(anonymousMutations)) {
    expect(result.results[0]).toMatchObject({
      error: { code: 'UNAUTHORIZED' },
      ok: false,
    });
  }
  expect(
    await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM ShareCommentThread) AS threads,
        (SELECT COUNT(*) FROM ShareCommentMessage) AS messages`,
    ).first(),
  ).toEqual(countsBeforeAnonymousMutations);

  for (const result of [
    await mutate('shareComment.updateMessage', { body: 'Owner edit.', messageId }, ownerCookie, [
      'id',
    ]),
    await mutate('shareComment.deleteMessage', { id: messageId }, ownerCookie, ['id']),
  ]) {
    expect(result.results[0]).toMatchObject({
      error: { code: 'FORBIDDEN' },
      ok: false,
    });
  }
  expect(
    (
      await mutate('shareComment.resolveThread', { resolved: true, threadId }, commenterCookie, [
        'id',
      ])
    ).results[0],
  ).toMatchObject({ error: { code: 'FORBIDDEN' }, ok: false });

  expect(
    (
      await mutate(
        'shareComment.updateMessage',
        { body: 'Edited by Grace.', messageId },
        commenterCookie,
        ['body', 'id'],
      )
    ).results[0],
  ).toMatchObject({ data: { body: 'Edited by Grace.' }, ok: true });
  expect(
    (
      await mutate('shareComment.resolveThread', { resolved: true, threadId }, ownerCookie, [
        'id',
        'status',
      ])
    ).results[0],
  ).toMatchObject({ data: { status: 'resolved' }, ok: true });
  expect(
    (
      await mutate(
        'shareComment.reply',
        { body: 'Reply while resolved.', threadId },
        commenterCookie,
        ['id'],
      )
    ).results[0],
  ).toMatchObject({ error: { code: 'BAD_REQUEST' }, ok: false });
  expect(
    (
      await mutate('shareComment.resolveThread', { resolved: false, threadId }, ownerCookie, [
        'id',
        'status',
      ])
    ).results[0],
  ).toMatchObject({ data: { status: 'open' }, ok: true });
  expect(
    (await mutate('shareComment.deleteMessage', { id: messageId }, commenterCookie, ['id']))
      .results[0],
  ).toMatchObject({ data: { id: messageId }, ok: true });
  expect(
    await env.DB.prepare('SELECT id FROM ShareCommentThread WHERE id = ?').bind(threadId).first(),
  ).toBeNull();

  expect((await queryComments(ownerCookie)).results[0]).toMatchObject({
    data: { canResolveComments: true },
    ok: true,
  });
});

test('allows only share owners to delete plans and walkthroughs', async () => {
  const ownerCookie = await signInWithGitHub(ada);
  const otherCookie = await signInWithGitHub(grace);
  const sharedPlan = await createAndUpload(ownerCookie, 'plan');
  const sharedWalkthrough = await createAndUpload(ownerCookie, 'walkthrough');

  const queryShare = (name: 'planBySlug' | 'walkthroughBySlug', slug: string, cookie?: string) =>
    fateOperation(
      {
        args: { slug },
        id: `${name}-delete-capability`,
        kind: 'query',
        name,
        select: ['canDelete', 'commentThreads.id', 'id'],
      },
      { cookie },
    );

  expect((await queryShare('planBySlug', sharedPlan.slug)).results[0]).toMatchObject({
    data: { canDelete: false },
    ok: true,
  });
  expect((await queryShare('planBySlug', sharedPlan.slug, otherCookie)).results[0]).toMatchObject({
    data: { canDelete: false },
    ok: true,
  });
  expect((await queryShare('planBySlug', sharedPlan.slug, ownerCookie)).results[0]).toMatchObject({
    data: { canDelete: true },
    ok: true,
  });
  expect(
    (await queryShare('walkthroughBySlug', sharedWalkthrough.slug, ownerCookie)).results[0],
  ).toMatchObject({
    data: { canDelete: true },
    ok: true,
  });

  for (const result of [
    await mutate('plan.delete', { id: sharedPlan.id }, undefined, ['id']),
    await mutate('walkthrough.delete', { id: sharedWalkthrough.id }, undefined, ['id']),
  ]) {
    expect(result.results[0]).toMatchObject({
      error: { code: 'UNAUTHORIZED' },
      ok: false,
    });
  }
  for (const result of [
    await mutate('plan.delete', { id: sharedPlan.id }, otherCookie, ['id']),
    await mutate('walkthrough.delete', { id: sharedWalkthrough.id }, otherCookie, ['id']),
  ]) {
    expect(result.results[0]).toMatchObject({
      error: { code: 'FORBIDDEN' },
      ok: false,
    });
  }

  const planRecord = await env.DB.prepare('SELECT objectKey FROM Plan WHERE id = ?')
    .bind(sharedPlan.id)
    .first<{ objectKey: string }>();
  const walkthroughRecord = await env.DB.prepare('SELECT objectKey FROM Walkthrough WHERE id = ?')
    .bind(sharedWalkthrough.id)
    .first<{ objectKey: string }>();
  if (!planRecord || !walkthroughRecord) {
    throw new Error('Expected both shares to exist before deletion.');
  }
  expect(await env.WALKTHROUGH_BUCKET.get(planRecord.objectKey)).not.toBeNull();
  expect(await env.WALKTHROUGH_BUCKET.get(walkthroughRecord.objectKey)).not.toBeNull();

  expect(
    (await mutate('plan.delete', { id: sharedPlan.id }, ownerCookie, ['id'])).results[0],
  ).toMatchObject({ data: { id: sharedPlan.id }, ok: true });
  expect(
    (await mutate('walkthrough.delete', { id: sharedWalkthrough.id }, ownerCookie, ['id']))
      .results[0],
  ).toMatchObject({ data: { id: sharedWalkthrough.id }, ok: true });

  expect(
    await env.DB.prepare('SELECT id FROM Plan WHERE id = ?').bind(sharedPlan.id).first(),
  ).toBeNull();
  expect(
    await env.DB.prepare('SELECT id FROM Walkthrough WHERE id = ?')
      .bind(sharedWalkthrough.id)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM ShareCommentThread
       WHERE planId = ? OR walkthroughId = ?`,
    )
      .bind(sharedPlan.id, sharedWalkthrough.id)
      .first(),
  ).toEqual({ count: 0 });
  expect(await env.WALKTHROUGH_BUCKET.get(planRecord.objectKey)).toBeNull();
  expect(await env.WALKTHROUGH_BUCKET.get(walkthroughRecord.objectKey)).toBeNull();
});

test('imports walkthrough discussions once and indexes valid comment files lazily', async () => {
  const cookie = await signInWithGitHub(ada);
  const sharedWalkthrough = await createAndUpload(cookie, 'walkthrough');
  const storedBefore = await env.DB.prepare(
    'SELECT commentsImportedAt, filesIndexedAt, objectKey FROM Walkthrough WHERE id = ?',
  )
    .bind(sharedWalkthrough.id)
    .first<{
      commentsImportedAt: null | number;
      filesIndexedAt: null | number;
      objectKey: string;
    }>();
  expect(storedBefore).toMatchObject({
    commentsImportedAt: null,
    filesIndexedAt: null,
  });
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS count FROM WalkthroughFile WHERE walkthroughId = ?')
      .bind(sharedWalkthrough.id)
      .first(),
  ).toEqual({ count: 0 });

  const query = () =>
    fateOperation(
      {
        args: { slug: sharedWalkthrough.slug },
        id: 'walkthrough-comments',
        kind: 'query',
        name: 'walkthroughBySlug',
        select: [
          'commentThreads.filePath',
          'commentThreads.id',
          'commentThreads.kind',
          'commentThreads.lineNumber',
          'commentThreads.messages.body',
          'commentThreads.sectionId',
          'commentThreads.side',
          'id',
        ],
      },
      { cookie },
    );
  const [firstQuery, secondQuery] = await Promise.all([query(), query()]);
  expect(firstQuery.results[0]?.ok).toBe(true);
  expect(secondQuery.results[0]?.ok).toBe(true);
  const importedThreads = firstQuery.results[0]?.data?.commentThreads as
    | { items: Array<unknown> }
    | undefined;
  expect(importedThreads?.items).toHaveLength(3);
  expect(
    await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM ShareCommentThread WHERE walkthroughId = ?) AS threads,
        (SELECT COUNT(*) FROM ShareCommentMessage
         WHERE threadId IN (SELECT id FROM ShareCommentThread WHERE walkthroughId = ?)) AS messages`,
    )
      .bind(sharedWalkthrough.id, sharedWalkthrough.id)
      .first(),
  ).toEqual({ messages: 4, threads: 3 });

  const createWalkthroughComment = (target: Record<string, unknown>) =>
    mutate(
      'shareComment.createThread',
      {
        body: 'Added from codiff.dev.',
        shareId: sharedWalkthrough.id,
        shareType: 'walkthrough',
        target,
      },
      cookie,
      ['id', 'kind'],
    );

  expect(
    (
      await createWalkthroughComment({
        filePath: 'src/review.ts',
        kind: 'walkthrough-diff',
        lineNumber: 1,
        sectionId: 'src/review.ts:unstaged',
        side: 'additions',
      })
    ).results[0],
  ).toMatchObject({ data: { kind: 'walkthrough-diff' }, ok: true });
  const persistedComments = (await query()).results[0]?.data?.commentThreads as
    | {
        items: Array<{
          node: {
            filePath: string | null;
            kind: string;
            lineNumber: number | null;
            messages: { items: Array<{ node: { body: string } }> };
            sectionId: string | null;
            side: string | null;
          };
        }>;
      }
    | undefined;
  expect(
    persistedComments?.items.find(({ node }) =>
      node.messages.items.some(({ node: message }) => message.body === 'Added from codiff.dev.'),
    )?.node,
  ).toMatchObject({
    filePath: 'src/review.ts',
    kind: 'walkthrough-diff',
    lineNumber: 1,
    sectionId: 'src/review.ts:unstaged',
    side: 'additions',
  });
  expect(
    await env.DB.prepare('SELECT path FROM WalkthroughFile WHERE walkthroughId = ?')
      .bind(sharedWalkthrough.id)
      .all(),
  ).toMatchObject({ results: [{ path: 'src/review.ts' }] });
  expect(
    await env.DB.prepare('SELECT filesIndexedAt FROM Walkthrough WHERE id = ?')
      .bind(sharedWalkthrough.id)
      .first(),
  ).toMatchObject({ filesIndexedAt: expect.any(Number) });

  if (!storedBefore) {
    throw new Error('Expected walkthrough storage metadata.');
  }
  await env.WALKTHROUGH_BUCKET.delete(storedBefore.objectKey);
  expect(
    (
      await createWalkthroughComment({
        anchor: 'file',
        filePath: 'src/review.ts',
        kind: 'walkthrough-diff',
      })
    ).results[0],
  ).toMatchObject({ data: { kind: 'walkthrough-diff' }, ok: true });
  expect(
    (
      await createWalkthroughComment({
        filePath: 'src/missing.ts',
        kind: 'walkthrough-diff',
        lineNumber: 1,
        side: 'additions',
      })
    ).results[0],
  ).toMatchObject({ error: { code: 'BAD_REQUEST' }, ok: false });
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS count FROM WalkthroughFile WHERE walkthroughId = ?')
      .bind(sharedWalkthrough.id)
      .first(),
  ).toEqual({ count: 1 });
});

test('serves public statistics and stable errors without storing invalid uploads', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const daySeconds = 24 * 60 * 60;
  const insertPlan = env.DB.prepare(
    `INSERT INTO Plan (
      byteSize, codiffVersion, createdAt, id, objectKey, schemaVersion, sha256, slug,
      sourceFileName, title, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertWalkthrough = env.DB.prepare(
    `INSERT INTO Walkthrough (
      byteSize, codiffVersion, createdAt, id, objectKey, schemaVersion, sha256, slug,
      sourceType, title, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    insertPlan.bind(
      100,
      '1.8.0',
      nowSeconds,
      'stats-plan-today',
      'plans/stats-plan-today/manifest.json',
      1,
      'stats-plan-sha-today',
      'stats-plan-today',
      'plan.md',
      'Stats plan today',
      nowSeconds,
    ),
    insertPlan.bind(
      100,
      '1.8.0',
      nowSeconds - 8 * daySeconds,
      'stats-plan-old',
      'plans/stats-plan-old/manifest.json',
      1,
      'stats-plan-sha-old',
      'stats-plan-old',
      'plan.md',
      'Stats plan old',
      nowSeconds - 8 * daySeconds,
    ),
    insertWalkthrough.bind(
      100,
      '1.8.0',
      nowSeconds - 2 * daySeconds,
      'stats-walkthrough',
      'walkthroughs/stats-walkthrough/manifest.json',
      1,
      'stats-walkthrough-sha',
      'stats-walkthrough',
      'commit',
      'Stats walkthrough',
      nowSeconds - 2 * daySeconds,
    ),
  ]);

  const statsPage = await SELF.fetch(`${origin}/stats`);
  expect(statsPage.status).toBe(200);
  expect(statsPage.headers.get('content-type')).toContain('text/html');
  const statsResult = await fateOperation({
    id: 'sharing-stats',
    kind: 'query',
    name: 'sharingStats',
    select: [
      'days.date',
      'days.plans',
      'days.walkthroughs',
      'id',
      'maxDailyShares',
      'totalPlans',
      'totalWalkthroughs',
    ],
  });
  expect(statsResult.results[0]).toMatchObject({
    data: {
      days: { items: expect.any(Array) },
      maxDailyShares: 1,
      totalPlans: 2,
      totalWalkthroughs: 1,
    },
    ok: true,
  });
  const statsDays = statsResult.results[0]?.data?.days as
    | { items: Array<{ node: { plans: number; walkthroughs: number } }> }
    | undefined;
  const days = statsDays?.items ?? [];
  expect(days).toHaveLength(7);
  expect(days.reduce((total, { node }) => total + node.plans, 0)).toBe(1);
  expect(days.reduce((total, { node }) => total + node.walkthroughs, 0)).toBe(1);

  expect(await readJson(await SELF.fetch(`${origin}/api/plans/does-not-exist/manifest`))).toEqual({
    error: 'not-found',
  });
  expect(
    await readJson(await SELF.fetch(`${origin}/api/walkthroughs/does-not-exist/manifest`)),
  ).toEqual({ error: 'not-found' });
  expect(await readJson(await SELF.fetch(`${origin}/api/unknown`))).toEqual({
    error: 'not-found',
  });

  const cookie = await signInWithGitHub(ada);
  const malformedIntent = (await createIntent(cookie)).value;
  const malformedResponse = await uploadShare(malformedIntent, {
    ...planSnapshot,
    preferences: { theme: 'sepia' },
  });
  expect(malformedResponse.status).toBe(400);
  expect(await readJson(malformedResponse)).toEqual({ error: 'invalid-manifest' });

  const unsupportedIntent = (await createIntent(cookie)).value;
  const unsupportedResponse = await uploadShare(unsupportedIntent, {
    ...planSnapshot,
    kind: 'unknown-share-kind',
  });
  expect(unsupportedResponse.status).toBe(400);
  expect(await readJson(unsupportedResponse)).toEqual({ error: 'unsupported-manifest' });
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM Plan WHERE sharedByUserId IS NOT NULL',
    ).first(),
  ).toEqual({ count: 0 });

  const oversizedIntent = (await createIntent(cookie)).value;
  const oversizedResponse = await SELF.fetch(`${origin}/api/uploads`, {
    body: 'x'.repeat(25 * 1024 * 1024 + 1),
    headers: {
      authorization: `Bearer ${oversizedIntent.secret}`,
      'content-type': 'application/json',
      'x-codiff-upload-code': oversizedIntent.code,
    },
    method: 'POST',
  });
  expect(oversizedResponse.status).toBe(413);
  expect(await readJson(oversizedResponse)).toEqual({ error: 'manifest-too-large' });
  expect(
    await env.DB.prepare('SELECT status FROM UploadIntent WHERE code = ?')
      .bind(oversizedIntent.code)
      .first(),
  ).toEqual({ status: 'claimed' });
});
