// @ts-check

const { randomUUID } = require('node:crypto');
const { renameSync, rmSync, writeFileSync } = require('node:fs');

/** @param {string} path @param {unknown} value */
const writeJsonAtomic = (path, value) => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, 'utf8');
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
};

/**
 * @param {{once: (event: string, listener: () => void) => void; show: () => void}} window
 * @param {import('../core/types.ts').CodiffLaunchOptions} launchOptions
 */
const registerWindowOpenReceipt = (window, launchOptions) => {
  window.once('ready-to-show', () => {
    window.show();
    if (launchOptions.agentReview && launchOptions.agentReviewOpenFile) {
      try {
        writeJsonAtomic(launchOptions.agentReviewOpenFile, {
          deliveryAvailable: true,
          deliveryId: launchOptions.agentReview.deliveryId,
          status: 'open',
          version: 1,
        });
      } catch {
        // The launcher may have timed out and removed its receipt directory.
      }
    }
  });
};

module.exports = { registerWindowOpenReceipt };
