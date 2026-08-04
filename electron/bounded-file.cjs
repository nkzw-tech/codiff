// @ts-check

const fs = require('node:fs');

/** @param {number} maxBytes */
const validateMaxBytes = (maxBytes) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('File byte limit must be a non-negative safe integer.');
  }
};

/**
 * Read a file without retaining more than its caller's byte budget. A
 * pre-read stat is useful for fast paths, but cannot make a later read safe:
 * the file can change between `stat` and `open`.
 *
 * @param {string} path
 * @param {number} maxBytes
 * @returns {Promise<{buffer: Buffer, status: 'ready'} | {status: 'too-large'}>}
 */
const readBoundedFile = async (path, maxBytes) => {
  validateMaxBytes(maxBytes);

  const handle = await fs.promises.open(path, 'r');
  try {
    /** @type {Array<Buffer>} */
    const chunks = [];
    let retainedBytes = 0;
    const chunkSize = 64 * 1024;
    while (true) {
      // Keep one extra byte of read capacity so an exact-limit file remains
      // valid while an appended byte becomes an explicit oversized result.
      const capacity = Math.min(chunkSize, maxBytes + 1 - retainedBytes);
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, null);
      if (bytesRead === 0) {
        return { buffer: Buffer.concat(chunks), status: 'ready' };
      }
      if (retainedBytes + bytesRead > maxBytes) {
        return { status: 'too-large' };
      }
      retainedBytes += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
};

/**
 * Synchronous counterpart for cache readers that deliberately stay on their
 * existing synchronous API. It has the same exact-limit behavior as the
 * asynchronous reader.
 *
 * @param {string} path
 * @param {number} maxBytes
 * @returns {{buffer: Buffer, status: 'ready'} | {status: 'too-large'}}
 */
const readBoundedFileSync = (path, maxBytes) => {
  validateMaxBytes(maxBytes);

  const descriptor = fs.openSync(path, 'r');
  try {
    /** @type {Array<Buffer>} */
    const chunks = [];
    let retainedBytes = 0;
    const chunkSize = 64 * 1024;
    while (true) {
      const capacity = Math.min(chunkSize, maxBytes + 1 - retainedBytes);
      const chunk = Buffer.allocUnsafe(capacity);
      const bytesRead = fs.readSync(descriptor, chunk, 0, capacity, null);
      if (bytesRead === 0) {
        return { buffer: Buffer.concat(chunks), status: 'ready' };
      }
      if (retainedBytes + bytesRead > maxBytes) {
        return { status: 'too-large' };
      }
      retainedBytes += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
};

module.exports = { readBoundedFile, readBoundedFileSync };
