import { parsePlanShareUpload } from '@nkzw/codiff-core/share';
import { z } from 'zod';
import { and, db, eq, sql, withDatabase, type D1Binding } from './db.ts';
import { reviewCommentPositionSchema } from './review-position.ts';
import { plan, shareDailyUsage, uploadIntent, user, walkthrough, type UserRow } from './schema.ts';
import {
  createUploadIntentSecret,
  hashUploadIntentSecret,
  verifyUploadIntentSecret,
} from './upload-intent.ts';

export type SharingBucket = {
  delete(key: string): Promise<unknown>;
  get(key: string): Promise<null | { body: ReadableStream; httpEtag?: string }>;
  put(
    key: string,
    value: ArrayBuffer | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
};

export type SharingEnv = {
  BETTER_AUTH_SECRET?: string;
  DB: D1Binding;
  PUBLIC_ORIGIN?: string;
  WALKTHROUGH_BUCKET: SharingBucket;
};

export type SharingApiOptions = {
  auth?: unknown;
  enforceDailyQuota?: boolean;
  onUploadIntentUpdated?: (update: {
    changed: Array<'shareKind' | 'status' | 'walkthroughSlug'>;
    id: string;
    shareKind: 'plan' | 'walkthrough';
    walkthroughSlug: string;
  }) => void;
};

type BetterAuthApi = {
  api: {
    getSession(options: {
      asResponse?: false;
      headers: Headers;
      returnHeaders?: boolean;
    }): Promise<unknown>;
  };
};

export type ShareUser = {
  id: string;
  image: null | string;
  name: string;
  username: null | string;
};

const boundedString = (maximum: number) => z.string().max(maximum);
const nonEmptyString = (maximum: number) => z.string().min(1).max(maximum);
const reviewAuthorSchema = z
  .object({
    avatarUrl: boundedString(2048).optional(),
    login: nonEmptyString(200),
    name: nonEmptyString(200).optional(),
  })
  .passthrough();
const reviewCommentSchema = z
  .object({
    anchor: z.enum(['file', 'line']).optional(),
    author: reviewAuthorSchema,
    body: boundedString(128 * 1024),
    filePath: nonEmptyString(4096),
    id: nonEmptyString(256),
    isThreadResolved: z.boolean().optional(),
    lineNumber: z.number().int().positive().optional(),
    position: reviewCommentPositionSchema.optional(),
    sectionId: nonEmptyString(4096).optional(),
    side: z.enum(['additions', 'deletions']).optional(),
    startLineNumber: z.number().int().positive().optional(),
    startSide: z.enum(['additions', 'deletions']).optional(),
    submittedAt: boundedString(64).optional(),
    threadId: nonEmptyString(256).optional(),
  })
  .passthrough()
  .refine(
    (comment) => !(comment.position != null && comment.sectionId != null),
    'A review comment cannot contain both sectionId and position.',
  )
  .refine(
    (comment) =>
      comment.anchor === 'file' ||
      (comment.lineNumber != null &&
        comment.side != null &&
        (comment.startLineNumber == null || comment.startSide != null)),
    'Invalid walkthrough review comment.',
  );
const generalCommentSchema = z
  .object({
    author: reviewAuthorSchema,
    body: boundedString(128 * 1024),
    id: nonEmptyString(256),
    submittedAt: boundedString(64).optional(),
  })
  .passthrough();
const generalCommentThreadSchema = z
  .object({
    comments: z.array(generalCommentSchema).max(1000),
    id: nonEmptyString(256),
    isResolved: z.boolean().optional(),
  })
  .passthrough();
const walkthroughFileSchema = z
  .object({
    path: nonEmptyString(4096),
  })
  .passthrough();
const walkthroughSourceSchema = z
  .object({
    host: boundedString(512).optional(),
    number: z.number().int().positive().optional(),
    projectPath: boundedString(4096).optional(),
    title: boundedString(300).optional(),
    type: nonEmptyString(64),
    url: boundedString(4096).optional(),
  })
  .passthrough();
const sharedReviewScopeSchema = z.object({
  kind: z.literal('merge-request'),
  structure: z.enum(['commit-by-commit', 'net-change']),
});
const walkthroughManifestSchema = z
  .object({
    branch: boundedString(1024).optional(),
    codiffVersion: nonEmptyString(100),
    exportedAt: boundedString(64),
    files: z.array(walkthroughFileSchema).max(100_000),
    kind: z.literal('codiff-walkthrough-share'),
    repository: z
      .object({
        generalComments: z.array(generalCommentThreadSchema).max(1000).optional(),
        source: walkthroughSourceSchema.optional(),
        title: boundedString(300).optional(),
      })
      .passthrough(),
    reviewComments: z.array(reviewCommentSchema).max(10_000).optional(),
    reviewScope: sharedReviewScopeSchema.optional(),
    version: z.literal(1),
    walkthrough: z
      .object({
        summary: boundedString(128 * 1024).optional(),
        title: nonEmptyString(300),
      })
      .passthrough(),
  })
  .passthrough();
const uploaderSchema = z
  .object({
    email: boundedString(320).optional(),
    name: boundedString(200).optional(),
  })
  .passthrough();
const walkthroughUploadSchema = z
  .object({
    snapshot: walkthroughManifestSchema,
    uploader: uploaderSchema.optional(),
  })
  .passthrough();

type WalkthroughManifest = z.infer<typeof walkthroughManifestSchema>;

type ParsedUpload =
  | {
      kind: 'plan';
      sharedByEmail: null | string;
      sharedByName: null | string;
      snapshot: ReturnType<typeof parsePlanShareUpload>['snapshot'];
    }
  | {
      kind: 'walkthrough';
      sharedByEmail: null | string;
      sharedByName: null | string;
      snapshot: WalkthroughManifest;
    };

const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  });

const notFound = () => json({ error: 'not-found' }, { status: 404 });
const badRequest = (message: string) => json({ error: message }, { status: 400 });
const unauthorized = () => json({ error: 'authentication-required' }, { status: 401 });
const maxUploadByteSize = 25 * 1024 * 1024;
const textEncoder = new TextEncoder();

export const readRequestText = async (request: Request, maximumByteSize: number) => {
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > maximumByteSize) {
    return null;
  }

  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteSize = 0;
  const chunks: Array<string> = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        chunks.push(decoder.decode());
        return chunks.join('');
      }

      byteSize += value.byteLength;
      if (byteSize > maximumByteSize) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best-effort; the size limit still determines the response.
        }
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const isBetterAuthApi = (value: unknown): value is BetterAuthApi =>
  isRecord(value) && isRecord(value.api) && typeof value.api.getSession === 'function';

const stringValue = (value: unknown) => (typeof value === 'string' && value ? value : null);

export const shareUserFromAuthValue = (value: unknown): ShareUser | null => {
  const result = isRecord(value) && isRecord(value.response) ? value.response : value;
  const userValue = isRecord(result) ? result.user : null;
  if (!isRecord(userValue)) {
    return null;
  }

  const id = stringValue(userValue.id);
  const name = stringValue(userValue.name) ?? stringValue(userValue.username);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    image: stringValue(userValue.image),
    name,
    username: stringValue(userValue.displayUsername) ?? stringValue(userValue.username),
  };
};

const shareUserFromRow = (row: UserRow | null | undefined): ShareUser | null =>
  row
    ? {
        id: row.id,
        image: row.image,
        name: row.name,
        username: row.displayUsername ?? row.username,
      }
    : null;

export const getAuthenticatedShareUser = async (
  request: Request,
  auth: SharingApiOptions['auth'],
): Promise<ShareUser | null> => {
  if (!isBetterAuthApi(auth)) {
    return null;
  }
  try {
    return shareUserFromAuthValue(
      await auth.api.getSession({
        asResponse: false,
        headers: request.headers,
        returnHeaders: true,
      }),
    );
  } catch {
    return null;
  }
};

const getShareUserById = async (userId: null | string) => {
  if (!userId) {
    return null;
  }
  const [record] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  return shareUserFromRow(record);
};

const randomToken = (bytes = 24) => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
};

const randomCode = () => randomToken(8).slice(0, 10).toUpperCase();
const publicOrigin = (request: Request, env: SharingEnv) => {
  const url = new URL(request.url);
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return (isLoopback ? url.origin : env.PUBLIC_ORIGIN || url.origin).replace(/\/+$/, '');
};

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const cleanTitleValue = (value: unknown) =>
  typeof value === 'string' ? value.replaceAll(/\s+/g, ' ').trim().slice(0, 300) || null : null;

const cleanIdentityValue = (value: unknown, maxLength: number) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) || null : null;

const sanitizeWalkthrough = (snapshot: WalkthroughManifest) => {
  const repository = snapshot.repository;
  const source = repository.source;
  const commitTitle =
    source?.type === 'commit'
      ? (cleanTitleValue(repository.title) ?? cleanTitleValue(snapshot.walkthrough.title))
      : null;
  const sanitizedRepository = {
    ...repository,
    root: commitTitle ?? 'Shared Codiff review',
    ...(commitTitle ? { title: commitTitle } : {}),
  };
  if (!commitTitle) {
    delete sanitizedRepository.title;
  }
  return { ...snapshot, repository: sanitizedRepository };
};

export const parseShareUpload = (body: string): ParsedUpload => {
  const payload: unknown = JSON.parse(body);
  const record = isRecord(payload) ? payload : null;
  const snapshotValue = record?.snapshot ?? payload;
  if (!isRecord(snapshotValue) || snapshotValue.version !== 1) {
    throw new Error('unsupported-manifest');
  }

  if (snapshotValue.kind === 'codiff-walkthrough-share') {
    const envelope = walkthroughUploadSchema.safeParse(payload);
    const parsed = envelope.success
      ? envelope.data
      : { snapshot: walkthroughManifestSchema.parse(payload) };
    return {
      kind: 'walkthrough',
      sharedByEmail: cleanIdentityValue(parsed.uploader?.email, 320),
      sharedByName: cleanIdentityValue(parsed.uploader?.name, 200),
      snapshot: sanitizeWalkthrough(parsed.snapshot),
    };
  }

  if (snapshotValue.kind !== 'codiff-plan-share') {
    throw new Error('unsupported-manifest');
  }

  const parsed = parsePlanShareUpload(payload);
  return {
    kind: 'plan',
    sharedByEmail: cleanIdentityValue(parsed.uploader?.email, 320),
    sharedByName: cleanIdentityValue(parsed.uploader?.name, 200),
    snapshot: parsed.snapshot,
  };
};

export const parseGitPullRequestUrl = (value: string | undefined) => {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    const gitLab = /^\/(.+)\/-\/merge_requests\/(\d+)(?:\/.*)?$/.exec(url.pathname);
    if (gitLab) {
      return {
        host: url.host,
        number: Number(gitLab[2]),
        projectPath: decodeURIComponent(gitLab[1]),
      };
    }
    const gitHub = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(url.pathname);
    if (gitHub) {
      return {
        host: url.host,
        number: Number(gitHub[3]),
        projectPath: `${decodeURIComponent(gitHub[1])}/${decodeURIComponent(gitHub[2])}`,
      };
    }
  } catch {
    return null;
  }
  return null;
};

export const getRepositoryMetadata = (source: WalkthroughManifest['repository']['source']) => {
  if (!source || source.type !== 'pull-request') {
    return null;
  }
  const parsed = parseGitPullRequestUrl(source.url);
  const projectPath = source.projectPath || parsed?.projectPath;
  const host = source.host || parsed?.host;
  if (!projectPath || !host) {
    return null;
  }
  const segments = projectPath.split('/');
  return {
    host,
    name: segments.at(-1) ?? projectPath,
    number: source.number ?? parsed?.number ?? null,
    owner: segments.slice(0, -1).join('/') || null,
    url: `https://${host}/${projectPath}`,
  };
};

const utcDateKey = (date = new Date()) => date.toISOString().slice(0, 10);

const quotaResponse = () => {
  const now = new Date();
  const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return json(
    {
      error: 'share-quota-exceeded',
      resetAt: resetAt.toISOString(),
    },
    {
      headers: { 'retry-after': String(Math.max(1, Math.ceil((+resetAt - +now) / 1000))) },
      status: 429,
    },
  );
};

const hasAvailableQuota = async (userId: string, kind?: 'plan' | 'walkthrough') => {
  const [usage] = await db
    .select()
    .from(shareDailyUsage)
    .where(
      // The table's compound primary key makes this lookup exact after both values are supplied.
      // Drizzle's generated predicate remains parameterized.
      sql`${shareDailyUsage.userId} = ${userId} and ${shareDailyUsage.date} = ${utcDateKey()}`,
    )
    .limit(1);
  if (!usage) {
    return true;
  }
  const total = usage.planCount + usage.walkthroughCount;
  return (
    total < 100 &&
    (kind === 'plan'
      ? usage.planCount < 50
      : kind === 'walkthrough'
        ? usage.walkthroughCount < 50
        : true)
  );
};

const createUploadIntent = async (
  request: Request,
  env: SharingEnv,
  options: SharingApiOptions,
) => {
  const code = randomCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  const secret = await createUploadIntentSecret(env, code, expiresAt);
  const tokenHash = await hashUploadIntentSecret(secret);
  const shareUser = await getAuthenticatedShareUser(request, options.auth);

  if (shareUser && options.enforceDailyQuota && !(await hasAvailableQuota(shareUser.id))) {
    return quotaResponse();
  }

  if (shareUser) {
    await db.insert(uploadIntent).values({
      claimedAt: now,
      code,
      expiresAt,
      secretHash: tokenHash,
      sharedByUserId: shareUser.id,
      status: 'claimed',
      updatedAt: now,
      uploadTokenHash: tokenHash,
    });
  }

  const origin = publicOrigin(request, env);
  return json({
    claimUrl: `${origin}/connect/${code}?secret=${secret}`,
    code,
    pollUrl: `${origin}/api/upload-intents/${code}?secret=${secret}`,
    secret,
    status: shareUser ? 'claimed' : 'pending',
  });
};

const readUploadIntent = async (request: Request, env: SharingEnv, code: string) => {
  const secret = new URL(request.url).searchParams.get('secret');
  if (!secret) {
    return badRequest('missing-secret');
  }

  const [intent] = await db.select().from(uploadIntent).where(eq(uploadIntent.code, code)).limit(1);
  const tokenHash = await hashUploadIntentSecret(secret);
  if (intent && intent.secretHash !== tokenHash) {
    return notFound();
  }
  const pending = intent ? null : await verifyUploadIntentSecret(env, code, secret);
  if (!intent && !pending) {
    return notFound();
  }
  const expiresAt = intent?.expiresAt ?? pending!.expiresAt;
  if (expiresAt.getTime() < Date.now() && intent?.status !== 'uploaded') {
    return json({ status: 'expired' }, { status: 410 });
  }
  if (!intent) {
    return json({ status: 'pending' });
  }

  return json({
    status: intent.status,
    uploadToken: intent.status === 'claimed' ? secret : undefined,
    url:
      intent.status === 'uploaded' && intent.walkthroughSlug
        ? `${publicOrigin(request, env)}/${intent.shareKind === 'plan' ? 'p' : 'w'}/${
            intent.walkthroughSlug
          }`
        : undefined,
  });
};

const isQuotaError = (error: unknown) =>
  error instanceof Error && error.message.toLowerCase().includes('share-quota-exceeded');

const uploadShare = async (request: Request, env: SharingEnv, options: SharingApiOptions) => {
  const code = request.headers.get('x-codiff-upload-code');
  const authorization = request.headers.get('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
  if (!code || !token) {
    return unauthorized();
  }

  const [intent] = await db.select().from(uploadIntent).where(eq(uploadIntent.code, code)).limit(1);
  if (
    !intent ||
    intent.status !== 'claimed' ||
    !intent.sharedByUserId ||
    intent.expiresAt.getTime() < Date.now() ||
    intent.uploadTokenHash !== (await sha256(token))
  ) {
    return unauthorized();
  }

  const body = await readRequestText(request, maxUploadByteSize);
  if (body === null) {
    return json({ error: 'manifest-too-large' }, { status: 413 });
  }

  let upload: ParsedUpload;
  try {
    upload = parseShareUpload(body);
  } catch (error) {
    return badRequest(
      error instanceof Error && error.message === 'unsupported-manifest'
        ? error.message
        : 'invalid-manifest',
    );
  }

  if (options.enforceDailyQuota && !(await hasAvailableQuota(intent.sharedByUserId, upload.kind))) {
    return quotaResponse();
  }

  const canonical = JSON.stringify(upload.snapshot);
  const digest = await sha256(canonical);
  const slug = randomToken(18);
  const objectKey = `${upload.kind === 'plan' ? 'plans' : 'walkthroughs'}/${slug}/manifest.json`;
  const shareUser = await getShareUserById(intent.sharedByUserId);
  if (!shareUser) {
    return unauthorized();
  }
  const now = new Date();

  const [ownedIntent] = await db
    .update(uploadIntent)
    .set({ status: 'uploading', updatedAt: now })
    .where(and(eq(uploadIntent.id, intent.id), eq(uploadIntent.status, 'claimed')))
    .returning({ id: uploadIntent.id });
  if (!ownedIntent) {
    return unauthorized();
  }

  try {
    await env.WALKTHROUGH_BUCKET.put(objectKey, canonical, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });

    if (upload.kind === 'walkthrough') {
      const source = upload.snapshot.repository.source;
      const repository = getRepositoryMetadata(source);
      const commitTitle =
        source?.type === 'commit' ? cleanTitleValue(upload.snapshot.repository.title) : null;
      const walkthroughId = crypto.randomUUID();
      await db.batch([
        db.insert(walkthrough).values({
          branch: upload.snapshot.branch ?? null,
          byteSize: textEncoder.encode(canonical).byteLength,
          codiffVersion: upload.snapshot.codiffVersion,
          description: upload.snapshot.walkthrough.summary ?? null,
          id: walkthroughId,
          objectKey,
          pullRequestNumber: repository?.number ?? source?.number ?? null,
          pullRequestTitle: source?.title ?? null,
          pullRequestUrl: source?.type === 'pull-request' ? (source.url ?? null) : null,
          repositoryHost: repository?.host ?? null,
          repositoryName: repository?.name ?? null,
          repositoryOwner: repository?.owner ?? null,
          repositoryUrl: repository?.url ?? null,
          schemaVersion: upload.snapshot.version,
          sha256: digest,
          sharedByEmail: null,
          sharedByName: null,
          sharedByUserId: shareUser.id,
          slug,
          sourceType: source?.type ?? 'unknown',
          title: commitTitle ?? upload.snapshot.walkthrough.title,
          updatedAt: now,
        }),
        db
          .update(uploadIntent)
          .set({
            shareKind: upload.kind,
            status: 'uploaded',
            updatedAt: now,
            walkthroughSlug: slug,
          })
          .where(and(eq(uploadIntent.id, intent.id), eq(uploadIntent.status, 'uploading'))),
      ]);
    } else {
      await db.batch([
        db.insert(plan).values({
          agent: cleanIdentityValue(upload.snapshot.source?.agent, 40),
          byteSize: textEncoder.encode(canonical).byteLength,
          codiffVersion: upload.snapshot.codiffVersion,
          objectKey,
          schemaVersion: upload.snapshot.version,
          sessionId: cleanIdentityValue(upload.snapshot.source?.sessionId, 200),
          sha256: digest,
          sharedByEmail: null,
          sharedByName: null,
          sharedByUserId: shareUser.id,
          slug,
          sourceFileName: cleanTitleValue(upload.snapshot.document.name) ?? 'plan.md',
          title: cleanTitleValue(upload.snapshot.document.title) ?? 'Codiff Plan',
          updatedAt: now,
        }),
        db
          .update(uploadIntent)
          .set({
            shareKind: upload.kind,
            status: 'uploaded',
            updatedAt: now,
            walkthroughSlug: slug,
          })
          .where(and(eq(uploadIntent.id, intent.id), eq(uploadIntent.status, 'uploading'))),
      ]);
    }
  } catch (error) {
    try {
      await env.WALKTHROUGH_BUCKET.delete(objectKey);
    } finally {
      await db
        .update(uploadIntent)
        .set({ status: 'claimed', updatedAt: new Date() })
        .where(and(eq(uploadIntent.id, intent.id), eq(uploadIntent.status, 'uploading')));
    }
    if (isQuotaError(error)) {
      return quotaResponse();
    }
    throw error;
  }

  options.onUploadIntentUpdated?.({
    changed:
      upload.kind === 'plan'
        ? ['shareKind', 'status', 'walkthroughSlug']
        : ['status', 'walkthroughSlug'],
    id: intent.id,
    shareKind: upload.kind,
    walkthroughSlug: slug,
  });

  return json({
    slug,
    status: 'uploaded',
    url: `${publicOrigin(request, env)}/${upload.kind === 'plan' ? 'p' : 'w'}/${slug}`,
  });
};

const getManifest = async (env: SharingEnv, kind: 'plan' | 'walkthrough', slug: string) => {
  const [record] =
    kind === 'plan'
      ? await db
          .select({ objectKey: plan.objectKey })
          .from(plan)
          .where(eq(plan.slug, slug))
          .limit(1)
      : await db
          .select({ objectKey: walkthrough.objectKey })
          .from(walkthrough)
          .where(eq(walkthrough.slug, slug))
          .limit(1);
  if (!record) {
    return notFound();
  }
  const object = await env.WALKTHROUGH_BUCKET.get(record.objectKey);
  if (!object) {
    return notFound();
  }
  return new Response(object.body, {
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-robots-tag': 'noindex',
    },
  });
};

const handleSharingApi = async (request: Request, env: SharingEnv, options: SharingApiOptions) => {
  const url = new URL(request.url);
  const uploadIntentMatch = /^\/api\/upload-intents\/([^/]+)$/.exec(url.pathname);
  const planManifestMatch = /^\/api\/plans\/([^/]+)\/manifest$/.exec(url.pathname);
  const walkthroughManifestMatch = /^\/api\/walkthroughs\/([^/]+)\/manifest$/.exec(url.pathname);

  if (request.method === 'POST' && url.pathname === '/api/upload-intents') {
    return createUploadIntent(request, env, options);
  }
  if (request.method === 'GET' && uploadIntentMatch) {
    return readUploadIntent(request, env, uploadIntentMatch[1]);
  }
  if (request.method === 'POST' && url.pathname === '/api/uploads') {
    return uploadShare(request, env, options);
  }
  if (request.method === 'GET' && planManifestMatch) {
    return getManifest(env, 'plan', planManifestMatch[1]);
  }
  if (request.method === 'GET' && walkthroughManifestMatch) {
    return getManifest(env, 'walkthrough', walkthroughManifestMatch[1]);
  }
  return notFound();
};

export const handleSharingApiRequest = (
  request: Request,
  env: SharingEnv,
  options: SharingApiOptions = {},
): Promise<Response> => withDatabase(env.DB, () => handleSharingApi(request, env, options));
