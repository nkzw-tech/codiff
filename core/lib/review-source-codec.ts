import type { ResolvedReviewSource, ReviewSource } from '../types.ts';
import codec from './review-source-codec.cjs';

const reviewSourceCodec = codec as {
  decodeResolvedReviewSource(value: unknown): unknown;
  decodeReviewSource(value: unknown): unknown;
  formatResolvedSourceIdentity(source: ResolvedReviewSource): string | null;
  formatReviewSourceIdentity(source: ResolvedReviewSource | ReviewSource): string | null;
};

export const decodeReviewSource = (value: unknown): ReviewSource | null =>
  reviewSourceCodec.decodeReviewSource(value) as ReviewSource | null;

export const decodeResolvedReviewSource = (value: unknown): ResolvedReviewSource | null =>
  reviewSourceCodec.decodeResolvedReviewSource(value) as ResolvedReviewSource | null;

export const formatReviewSourceIdentity = (source: ResolvedReviewSource | ReviewSource): string =>
  reviewSourceCodec.formatReviewSourceIdentity(source) as string;

export const formatResolvedSourceIdentity = (source: ResolvedReviewSource): string =>
  reviewSourceCodec.formatResolvedSourceIdentity(source) as string;
