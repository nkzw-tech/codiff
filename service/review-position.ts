import { z } from 'zod';

const nonEmptyString = (maximum: number) => z.string().min(1).max(maximum);

export const revisionLabelSchema = z.object({
  kind: z.enum(['bookmark', 'branch', 'commit', 'review-marker', 'tag', 'version']),
  text: nonEmptyString(4096),
  url: z.string().url().max(4096).optional(),
});

export const revisionSchema = z.union([
  z.object({
    aliases: z.array(revisionLabelSchema).max(100).readonly().optional(),
    kind: z.literal('commit').optional(),
    label: revisionLabelSchema,
    sha: nonEmptyString(256),
  }),
  z.object({
    aliases: z.array(revisionLabelSchema).max(100).readonly().optional(),
    kind: z.literal('index'),
    label: revisionLabelSchema,
  }),
  z.object({
    aliases: z.array(revisionLabelSchema).max(100).readonly().optional(),
    kind: z.literal('working-copy'),
    label: revisionLabelSchema,
  }),
]);

export const diffRangeSchema = z.object({
  base: revisionSchema.nullable(),
  head: revisionSchema.nullable(),
});

/** Durable, range-only coordinate for a shared walkthrough review comment. */
export const reviewCommentPositionSchema = z.object({ range: diffRangeSchema }).strict();
