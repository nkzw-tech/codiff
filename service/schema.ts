import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const idColumn = () =>
  text()
    .notNull()
    .$defaultFn(() => crypto.randomUUID());

const timestampColumn = () =>
  integer({ mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`);
const nullableTimestampColumn = () => integer({ mode: 'timestamp' });

export const shareCommentThreadKind = ['plan', 'walkthrough-diff', 'walkthrough-general'] as const;
export const shareCommentThreadStatus = ['open', 'resolved'] as const;
export const shareKind = ['plan', 'walkthrough'] as const;

export const user = sqliteTable(
  'user',
  {
    banExpires: nullableTimestampColumn(),
    banned: integer({ mode: 'boolean' }),
    banReason: text(),
    createdAt: timestampColumn(),
    displayUsername: text(),
    email: text().notNull(),
    emailVerified: integer({ mode: 'boolean' }).notNull().default(false),
    id: idColumn().primaryKey(),
    image: text(),
    name: text().notNull(),
    password: text(),
    role: text().notNull().default('user'),
    updatedAt: timestampColumn(),
    username: text(),
  },
  (table) => [
    uniqueIndex('user_email_key').on(table.email),
    uniqueIndex('user_username_key').on(table.username),
    index('user_id_idx').on(table.id),
  ],
);

export const walkthrough = sqliteTable(
  'Walkthrough',
  {
    branch: text(),
    byteSize: integer().notNull(),
    codiffVersion: text().notNull(),
    commentsImportedAt: nullableTimestampColumn(),
    createdAt: timestampColumn(),
    description: text(),
    filesIndexedAt: nullableTimestampColumn(),
    id: idColumn().primaryKey(),
    objectKey: text().notNull(),
    pullRequestNumber: integer(),
    pullRequestTitle: text(),
    pullRequestUrl: text(),
    repositoryHost: text(),
    repositoryName: text(),
    repositoryOwner: text(),
    repositoryUrl: text(),
    schemaVersion: integer().notNull(),
    sha256: text().notNull(),
    sharedByEmail: text(),
    sharedByName: text(),
    sharedByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    slug: text().notNull(),
    sourceType: text().notNull(),
    title: text().notNull(),
    updatedAt: timestampColumn(),
  },
  (table) => [
    uniqueIndex('Walkthrough_slug_key').on(table.slug),
    index('Walkthrough_sharedByEmail_idx').on(table.sharedByEmail),
    index('Walkthrough_sharedByUserId_idx').on(table.sharedByUserId),
    index('Walkthrough_repository_idx').on(table.repositoryOwner, table.repositoryName),
  ],
);

export const walkthroughFile = sqliteTable(
  'WalkthroughFile',
  {
    path: text().notNull(),
    walkthroughId: text()
      .notNull()
      .references(() => walkthrough.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({
      columns: [table.walkthroughId, table.path],
      name: 'WalkthroughFile_walkthroughId_path_pkey',
    }),
  ],
);

export const plan = sqliteTable(
  'Plan',
  {
    agent: text(),
    byteSize: integer().notNull(),
    codiffVersion: text().notNull(),
    commentsImportedAt: nullableTimestampColumn(),
    createdAt: timestampColumn(),
    id: idColumn().primaryKey(),
    objectKey: text().notNull(),
    schemaVersion: integer().notNull(),
    sessionId: text(),
    sha256: text().notNull(),
    sharedByEmail: text(),
    sharedByName: text(),
    sharedByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    slug: text().notNull(),
    sourceFileName: text().notNull(),
    title: text().notNull(),
    updatedAt: timestampColumn(),
  },
  (table) => [
    uniqueIndex('Plan_slug_key').on(table.slug),
    index('Plan_sharedByEmail_idx').on(table.sharedByEmail),
    index('Plan_sharedByUserId_idx').on(table.sharedByUserId),
  ],
);

export const uploadIntent = sqliteTable(
  'UploadIntent',
  {
    claimedAt: nullableTimestampColumn(),
    code: text().notNull(),
    createdAt: timestampColumn(),
    expiresAt: integer({ mode: 'timestamp' }).notNull(),
    id: idColumn().primaryKey(),
    secretHash: text().notNull(),
    sharedByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    shareKind: text({ enum: shareKind }).notNull().default('walkthrough'),
    status: text({ enum: ['pending', 'claimed', 'uploading', 'uploaded'] })
      .notNull()
      .default('pending'),
    updatedAt: timestampColumn(),
    uploadTokenHash: text(),
    walkthroughSlug: text(),
  },
  (table) => [
    uniqueIndex('UploadIntent_code_key').on(table.code),
    index('UploadIntent_sharedByUserId_idx').on(table.sharedByUserId),
  ],
);

export const shareCommentThread = sqliteTable(
  'ShareCommentThread',
  {
    anchorJson: text(),
    createdAt: timestampColumn(),
    filePath: text(),
    id: idColumn().primaryKey(),
    kind: text({ enum: shareCommentThreadKind }).notNull(),
    lineNumber: integer(),
    planId: text().references(() => plan.id, { onDelete: 'cascade' }),
    positionJson: text(),
    resolvedAt: nullableTimestampColumn(),
    sectionId: text(),
    side: text({ enum: ['additions', 'deletions'] }),
    sourceThreadId: text(),
    startLineNumber: integer(),
    startSide: text({ enum: ['additions', 'deletions'] }),
    status: text({ enum: shareCommentThreadStatus }).notNull().default('open'),
    updatedAt: timestampColumn(),
    walkthroughId: text().references(() => walkthrough.id, { onDelete: 'cascade' }),
  },
  (table) => [
    check(
      'ShareCommentThread_parent_check',
      sql`(${table.planId} is not null and ${table.walkthroughId} is null) or (${table.planId} is null and ${table.walkthroughId} is not null)`,
    ),
    index('ShareCommentThread_planId_createdAt_idx').on(table.planId, table.createdAt),
    index('ShareCommentThread_walkthroughId_createdAt_idx').on(
      table.walkthroughId,
      table.createdAt,
    ),
    uniqueIndex('ShareCommentThread_planId_sourceThreadId_key').on(
      table.planId,
      table.sourceThreadId,
    ),
    uniqueIndex('ShareCommentThread_walkthroughId_sourceThreadId_key').on(
      table.walkthroughId,
      table.sourceThreadId,
    ),
  ],
);

export const shareCommentMessage = sqliteTable(
  'ShareCommentMessage',
  {
    authorImage: text(),
    authorName: text().notNull(),
    authorUserId: text().references(() => user.id, { onDelete: 'set null' }),
    authorUsername: text(),
    body: text().notNull(),
    createdAt: timestampColumn(),
    id: idColumn().primaryKey(),
    sourceMessageId: text(),
    threadId: text()
      .notNull()
      .references(() => shareCommentThread.id, { onDelete: 'cascade' }),
    updatedAt: timestampColumn(),
  },
  (table) => [
    index('ShareCommentMessage_authorUserId_idx').on(table.authorUserId),
    index('ShareCommentMessage_threadId_createdAt_idx').on(table.threadId, table.createdAt),
    uniqueIndex('ShareCommentMessage_threadId_sourceMessageId_key').on(
      table.threadId,
      table.sourceMessageId,
    ),
  ],
);

export const shareDailyUsage = sqliteTable(
  'ShareDailyUsage',
  {
    date: text().notNull(),
    planCount: integer().notNull().default(0),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    walkthroughCount: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.date],
      name: 'ShareDailyUsage_userId_date_pkey',
    }),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  shareCommentMessages: many(shareCommentMessage),
  shareDailyUsage: many(shareDailyUsage),
}));

export const walkthroughRelations = relations(walkthrough, ({ many }) => ({
  commentThreads: many(shareCommentThread),
  files: many(walkthroughFile),
}));

export const walkthroughFileRelations = relations(walkthroughFile, ({ one }) => ({
  walkthrough: one(walkthrough, {
    fields: [walkthroughFile.walkthroughId],
    references: [walkthrough.id],
  }),
}));

export const planRelations = relations(plan, ({ many }) => ({
  commentThreads: many(shareCommentThread),
}));

export const shareCommentThreadRelations = relations(shareCommentThread, ({ many, one }) => ({
  messages: many(shareCommentMessage),
  plan: one(plan, {
    fields: [shareCommentThread.planId],
    references: [plan.id],
  }),
  walkthrough: one(walkthrough, {
    fields: [shareCommentThread.walkthroughId],
    references: [walkthrough.id],
  }),
}));

export const shareCommentMessageRelations = relations(shareCommentMessage, ({ one }) => ({
  author: one(user, {
    fields: [shareCommentMessage.authorUserId],
    references: [user.id],
  }),
  thread: one(shareCommentThread, {
    fields: [shareCommentMessage.threadId],
    references: [shareCommentThread.id],
  }),
}));

export const shareDailyUsageRelations = relations(shareDailyUsage, ({ one }) => ({
  user: one(user, {
    fields: [shareDailyUsage.userId],
    references: [user.id],
  }),
}));

export type UserRow = typeof user.$inferSelect;
export type UploadIntentRow = typeof uploadIntent.$inferSelect;
export type PlanRow = typeof plan.$inferSelect;
export type WalkthroughRow = typeof walkthrough.$inferSelect;
export type ShareCommentThreadRow = typeof shareCommentThread.$inferSelect;
export type ShareCommentMessageRow = typeof shareCommentMessage.$inferSelect;
export type ShareCommentThreadKind = (typeof shareCommentThreadKind)[number];
export type ShareCommentThreadStatus = (typeof shareCommentThreadStatus)[number];

const schema = {
  plan,
  planRelations,
  shareCommentMessage,
  shareCommentMessageRelations,
  shareCommentThread,
  shareCommentThreadRelations,
  shareDailyUsage,
  shareDailyUsageRelations,
  uploadIntent,
  user,
  userRelations,
  walkthrough,
  walkthroughFile,
  walkthroughFileRelations,
  walkthroughRelations,
} as const;

export default schema;
