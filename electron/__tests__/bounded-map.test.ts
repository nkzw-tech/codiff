import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { mapWithConcurrency } = require('../bounded-map.cjs') as {
  mapWithConcurrency: <Input, Output>(
    values: ReadonlyArray<Input>,
    concurrency: number,
    map: (value: Input, index: number) => Promise<Output>,
  ) => Promise<Array<Output>>;
};

test('bounds concurrent work and retains input order', async () => {
  const values = Array.from({ length: 10 }, (_, index) => index);
  let active = 0;
  let peak = 0;

  const output = await mapWithConcurrency(values, 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return `value:${value}`;
  });

  expect(peak).toBe(3);
  expect(output).toEqual(values.map((value) => `value:${value}`));
});

test('does not start more work after a failure', async () => {
  const started: Array<number> = [];

  await expect(
    mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      if (value === 0) {
        throw new Error('expected failure');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return value;
    }),
  ).rejects.toThrow('expected failure');

  expect(started).toEqual([0, 1]);
});
