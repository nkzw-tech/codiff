import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { getReviewedDiffSignature } = require('../reviewed-diff-signature.cjs') as {
  getReviewedDiffSignature: (
    files: ReadonlyArray<{
      fingerprint: string;
      oldPath?: string;
      path: string;
      sections: ReadonlyArray<{ range?: unknown }>;
      status: string;
    }>,
  ) => string;
};

const file = (base: string, path = 'src/app.ts') => ({
  fingerprint: 'same-content',
  path,
  sections: [
    {
      range: {
        base: { kind: 'commit', sha: base },
        head: { kind: 'commit', sha: 'h'.repeat(40) },
      },
    },
  ],
  status: 'modified',
});

test('reviewed diff signatures change for base-only changes and ignore file order', () => {
  const first = getReviewedDiffSignature([file('a'.repeat(40)), file('a'.repeat(40), 'b.ts')]);

  expect(getReviewedDiffSignature([file('b'.repeat(40)), file('a'.repeat(40), 'b.ts')])).not.toBe(
    first,
  );
  expect(getReviewedDiffSignature([file('a'.repeat(40), 'b.ts'), file('a'.repeat(40))])).toBe(
    first,
  );
});
