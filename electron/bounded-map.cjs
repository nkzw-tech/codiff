// @ts-check

/**
 * Map a finite batch without allowing one failed or large input to create an
 * unbounded number of pending operations. Started work is allowed to settle
 * before the first failure is surfaced, but no additional item starts after
 * that failure.
 *
 * @template Input
 * @template Output
 * @param {ReadonlyArray<Input>} values
 * @param {number} concurrency
 * @param {(value: Input, index: number) => Promise<Output>} map
 * @returns {Promise<Array<Output>>}
 */
const mapWithConcurrency = async (values, concurrency, map) => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Concurrency must be a positive integer.');
  }
  /** @type {Array<Output>} */
  const output = new Array(values.length);
  let nextIndex = 0;
  let failed = false;
  /** @type {unknown} */
  let failure;
  const worker = async () => {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex++;
      try {
        output[index] = await map(values[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  if (failed) {
    throw failure;
  }
  return output;
};

module.exports = { mapWithConcurrency };
