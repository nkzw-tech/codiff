import {
  array,
  integer,
  maxLength,
  maxValue,
  minLength,
  minValue,
  number,
  optional,
  parse,
  picklist,
  pipe,
  regex,
  safeParse,
  strictObject,
  string,
} from 'valibot';
import type { WalkthroughGenerationProgress } from '../types.ts';

const codecVersion = 'v1';
export const walkthroughProgressPrefix = `codiff-walkthrough-progress:${codecVersion}:`;

const nonEmptyString = (maximum: number) => pipe(string(), minLength(1), maxLength(maximum));
const identifier = pipe(
  nonEmptyString(200),
  regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/, 'Invalid walkthrough progress identifier.'),
);
const count = pipe(number(), integer(), minValue(0), maxValue(1_000_000));

const walkthroughGenerationUnitProgressSchema = strictObject({
  detail: optional(nonEmptyString(10_000)),
  id: identifier,
  label: nonEmptyString(1000),
  status: picklist(['failed', 'generating', 'pending', 'preparing', 'ready']),
});

const walkthroughGenerationProgressSchema = strictObject({
  completed: optional(count),
  phase: picklist(['combining', 'generating', 'generating-units', 'preparing']),
  summary: nonEmptyString(10_000),
  total: optional(count),
  units: optional(array(walkthroughGenerationUnitProgressSchema)),
});

export const encodeWalkthroughProgress = (progress: WalkthroughGenerationProgress): string =>
  `${walkthroughProgressPrefix}${JSON.stringify(parse(walkthroughGenerationProgressSchema, progress))}`;

export const decodeWalkthroughProgress = (
  value: string | null | undefined,
): WalkthroughGenerationProgress | null => {
  if (!value?.startsWith(walkthroughProgressPrefix)) {
    return null;
  }
  try {
    const result = safeParse(
      walkthroughGenerationProgressSchema,
      JSON.parse(value.slice(walkthroughProgressPrefix.length)),
    );
    return result.success ? result.output : null;
  } catch {
    return null;
  }
};
