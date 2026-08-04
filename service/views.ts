import { computed, dataView, type Entity, FateRequestError, field, list } from '@nkzw/fate/server';
import type {
  PlanRow,
  ShareCommentMessageRow,
  ShareCommentThreadRow,
  UploadIntentRow,
  WalkthroughRow,
} from './schema.ts';

export const uploadIntentSecretHeader = 'x-codiff-upload-secret';

type PermissionContext = {
  auth: null | {
    api: {
      getSession(options: { asResponse?: false; headers: Headers }): Promise<unknown>;
    };
  };
  request: Request;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

export const getSessionUserId = (value: unknown) => {
  const result = isRecord(value) && isRecord(value.response) ? value.response : value;
  const sessionUser = isRecord(result) ? result.user : null;
  return isRecord(sessionUser) && typeof sessionUser.id === 'string' && sessionUser.id
    ? sessionUser.id
    : null;
};

const sessionUserIds = new WeakMap<Request, Promise<null | string>>();

const readContextSessionUserId = (context: PermissionContext) => {
  if (!context.auth) {
    return Promise.resolve(null);
  }
  const existing = sessionUserIds.get(context.request);
  if (existing) {
    return existing;
  }
  const result = context.auth.api
    .getSession({
      asResponse: false,
      headers: context.request.headers,
    })
    .then(getSessionUserId);
  sessionUserIds.set(context.request, result);
  return result;
};

const canManageShare = <
  Row extends {
    sharedByUserId: null | string;
  },
>() =>
  computed<Row, boolean, PermissionContext>({
    resolve: async (_record, values, context) =>
      Boolean(
        values.sharedByUserId &&
        context?.auth &&
        (await readContextSessionUserId(context)) === values.sharedByUserId,
      ),
    select: {
      sharedByUserId: field('sharedByUserId'),
    },
  });

const canEditShareComment = () =>
  computed<ShareCommentMessageRow, boolean, PermissionContext>({
    resolve: async (_record, values, context) =>
      Boolean(
        values.authorUserId &&
        context?.auth &&
        (await readContextSessionUserId(context)) === values.authorUserId,
      ),
    select: {
      authorUserId: field('authorUserId'),
    },
  });

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const protectedUploadIntentField = <
  FieldName extends 'expiresAt' | 'shareKind' | 'status' | 'walkthroughSlug',
>(
  fieldName: FieldName,
) =>
  computed<UploadIntentRow, UploadIntentRow[FieldName], { request: Request }>({
    resolve: async (_intent, values, context) => {
      const secret = context?.request.headers.get(uploadIntentSecretHeader);
      if (!secret || values.secretHash !== (await sha256(secret))) {
        throw new FateRequestError('NOT_FOUND', 'Upload intent not found.');
      }
      return values.value as UploadIntentRow[FieldName];
    },
    select: {
      secretHash: field('secretHash'),
      value: field(fieldName),
    },
  });

export const uploadIntentDataView = dataView<UploadIntentRow>('UploadIntent')({
  expiresAt: protectedUploadIntentField('expiresAt'),
  id: true,
  shareKind: protectedUploadIntentField('shareKind'),
  status: protectedUploadIntentField('status'),
  walkthroughSlug: protectedUploadIntentField('walkthroughSlug'),
});

export type UploadIntent = Entity<typeof uploadIntentDataView, 'UploadIntent'>;

export const shareCommentMessageDataView = dataView<ShareCommentMessageRow>('ShareCommentMessage')({
  authorImage: true,
  authorName: true,
  authorUsername: true,
  body: true,
  canEdit: canEditShareComment(),
  createdAt: true,
  id: true,
  threadId: true,
  updatedAt: true,
});

export type ShareCommentMessage = Entity<typeof shareCommentMessageDataView, 'ShareCommentMessage'>;

export const shareCommentThreadDataView = dataView<ShareCommentThreadRow>('ShareCommentThread')({
  anchorJson: true,
  createdAt: true,
  filePath: true,
  id: true,
  kind: true,
  lineNumber: true,
  messages: list(shareCommentMessageDataView, {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  }),
  planId: true,
  positionJson: true,
  resolvedAt: true,
  sectionId: true,
  side: true,
  startLineNumber: true,
  startSide: true,
  status: true,
  updatedAt: true,
  walkthroughId: true,
});

export type ShareCommentThread = Entity<
  typeof shareCommentThreadDataView,
  'ShareCommentThread',
  {
    messages: Array<ShareCommentMessage>;
  }
>;

export const walkthroughDataView = dataView<WalkthroughRow>('Walkthrough')({
  branch: true,
  byteSize: true,
  canDelete: canManageShare<WalkthroughRow>(),
  canResolveComments: canManageShare<WalkthroughRow>(),
  codiffVersion: true,
  commentThreads: list(shareCommentThreadDataView, {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  }),
  createdAt: true,
  description: true,
  id: true,
  pullRequestNumber: true,
  pullRequestTitle: true,
  pullRequestUrl: true,
  repositoryHost: true,
  repositoryName: true,
  repositoryOwner: true,
  repositoryUrl: true,
  schemaVersion: true,
  sha256: true,
  slug: true,
  sourceType: true,
  title: true,
  updatedAt: true,
});

export type Walkthrough = Entity<
  typeof walkthroughDataView,
  'Walkthrough',
  {
    commentThreads: Array<ShareCommentThread>;
  }
>;

export const planDataView = dataView<PlanRow>('Plan')({
  agent: true,
  byteSize: true,
  canDelete: canManageShare<PlanRow>(),
  canResolveComments: canManageShare<PlanRow>(),
  codiffVersion: true,
  commentThreads: list(shareCommentThreadDataView, {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  }),
  createdAt: true,
  id: true,
  schemaVersion: true,
  slug: true,
  sourceFileName: true,
  title: true,
  updatedAt: true,
});

export type Plan = Entity<
  typeof planDataView,
  'Plan',
  {
    commentThreads: Array<ShareCommentThread>;
  }
>;

export type ShareStatsDayRecord = {
  date: string;
  id: string;
  mergeRequestWalkthroughs: number;
  plans: number;
  walkthroughs: number;
};

export type ShareStatsRecord = {
  days: Array<ShareStatsDayRecord>;
  id: string;
  maxDailyShares: number;
  totalMergeRequestWalkthroughs: number;
  totalPlans: number;
  totalWalkthroughs: number;
};

export const shareStatsDayDataView = dataView<ShareStatsDayRecord>('ShareStatsDay')({
  date: true,
  id: true,
  mergeRequestWalkthroughs: true,
  plans: true,
  walkthroughs: true,
});

export type ShareStatsDay = Entity<typeof shareStatsDayDataView, 'ShareStatsDay'>;

export const shareStatsDataView = dataView<ShareStatsRecord>('ShareStats')({
  days: list(shareStatsDayDataView),
  id: true,
  maxDailyShares: true,
  totalMergeRequestWalkthroughs: true,
  totalPlans: true,
  totalWalkthroughs: true,
});

export type ShareStats = Entity<
  typeof shareStatsDataView,
  'ShareStats',
  {
    days: Array<ShareStatsDay>;
  }
>;

export const SharingRoot = {
  planBySlug: planDataView,
  sharingStats: shareStatsDataView,
  uploadIntentByCode: uploadIntentDataView,
  walkthroughBySlug: walkthroughDataView,
} as const;
