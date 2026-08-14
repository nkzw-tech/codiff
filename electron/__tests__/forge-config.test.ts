import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const config = require('../../forge.config.cjs') as {
  packagerConfig: { ignore: ReadonlyArray<RegExp> };
};

test('desktop packaging excludes deterministic examples and screenshots', () => {
  expect(config.packagerConfig.ignore.some((pattern) => pattern.test('/examples'))).toBe(true);
  expect(
    config.packagerConfig.ignore.some((pattern) =>
      pattern.test('/examples/definition-navigation/screenshots/command-click.png'),
    ),
  ).toBe(true);
});
