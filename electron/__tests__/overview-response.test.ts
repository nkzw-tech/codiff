import { createRequire } from 'node:module';
import { describe, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { parseOverviewResponse } = require('../overview-response.cjs') as {
  parseOverviewResponse: (response: unknown) => { focus: string };
};

describe('parseOverviewResponse', () => {
  test('parses plain serialized JSON', () => {
    expect(parseOverviewResponse('{"focus":"  Review the cache invalidation.  "}')).toEqual({
      focus: 'Review the cache invalidation.',
    });
  });

  test('parses fenced JSON', () => {
    expect(parseOverviewResponse('```json\n{"focus":"Review the migration."}\n```')).toEqual({
      focus: 'Review the migration.',
    });
  });

  test('parses structured backend responses after serialization', () => {
    expect(parseOverviewResponse({ focus: 'Review the parser.' })).toEqual({
      focus: 'Review the parser.',
    });
  });

  test('rejects malformed or empty responses', () => {
    expect(() => parseOverviewResponse('not json')).toThrow('not valid JSON');
    expect(() => parseOverviewResponse('{"focus":" "}')).toThrow('non-empty focus');
  });
});
