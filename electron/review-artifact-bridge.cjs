// @ts-check

/**
 * CJS bridge to the Core Review Artifact Run implementation.
 */

const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Keep successful dynamic imports single-flight, but do not permanently cache
 * a transient build or startup failure. A later caller must be able to retry
 * after the built module becomes available.
 *
 * @template T
 * @param {() => Promise<T>} load
 * @returns {() => Promise<T>}
 */
const createRetryableModuleLoader = (load) => {
  /** @type {Promise<T> | null} */
  let modulePromise = null;
  return () => {
    if (!modulePromise) {
      const attempt = Promise.resolve().then(load);
      modulePromise = attempt;
      void attempt.catch(() => {
        if (modulePromise === attempt) {
          modulePromise = null;
        }
      });
    }
    return modulePromise;
  };
};

let importAttempt = 0;
const loadReviewArtifacts = createRetryableModuleLoader(() => {
  const modulePath = join(__dirname, '../core/dist/index.mjs');
  const moduleUrl = pathToFileURL(modulePath);
  // Node memoizes failed ESM evaluations by URL. A retry gets a distinct URL
  // so a rebuilt Core module is actually loaded instead of replaying that error.
  moduleUrl.searchParams.set('codiff-load-attempt', String(importAttempt));
  importAttempt += 1;
  return import(moduleUrl.href);
});

module.exports = { createRetryableModuleLoader, loadReviewArtifacts };
