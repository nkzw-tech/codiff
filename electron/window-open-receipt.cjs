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
 * @param {{destroy: () => void; isDestroyed: () => boolean; once: (event: string, listener: () => Promise<void>) => void; show: () => void}} window
 * @param {import('../core/types.ts').CodiffLaunchOptions} launchOptions
 * @param {Promise<{available: boolean; reason?: string}> | null} deliveryPreflight
 */
const registerWindowOpenReceipt = (window, launchOptions, deliveryPreflight) => {
  window.once('ready-to-show', async () => {
    window.show();
    if (launchOptions.agentReview && launchOptions.agentReviewOpenFile) {
      const capability = await deliveryPreflight;
      if (window.isDestroyed()) return;
      try {
        writeJsonAtomic(launchOptions.agentReviewOpenFile, {
          deliveryAvailable: capability.available,
          deliveryId: launchOptions.agentReview.deliveryId,
          ...(capability.reason ? { reason: capability.reason } : {}),
          status: 'open',
          version: 1,
        });
      } catch {
        if (!window.isDestroyed()) window.destroy();
      }
    }
  });
};

module.exports = { registerWindowOpenReceipt };
