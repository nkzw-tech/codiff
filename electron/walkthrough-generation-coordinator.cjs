// @ts-check

const SUPERSEDED_GENERATION_REASON = 'A newer walkthrough generation request replaced this one.';

const createWalkthroughGenerationCoordinator = () => {
  /** @type {Map<number, AbortController>} */
  const active = new Map();
  /** @type {Map<number, {cacheKey: string; components: ReadonlyArray<any>}>} */
  const reusable = new Map();

  /** @param {number} key @param {unknown} [reason] */
  const cancel = (key, reason = new Error('Walkthrough generation was canceled.')) => {
    const controller = active.get(key);
    if (!controller) {
      return;
    }
    active.delete(key);
    controller.abort(reason);
  };

  return {
    /** @param {number} key */
    begin(key) {
      active.get(key)?.abort(new Error(SUPERSEDED_GENERATION_REASON));
      const controller = new AbortController();
      active.set(key, controller);
      return controller;
    },

    cancel,

    /** @param {number} key @param {unknown} [reason] */
    clear(key, reason = new Error('The walkthrough window was closed.')) {
      cancel(key, reason);
      reusable.delete(key);
    },

    /** @param {number} key @param {AbortController} controller */
    finish(key, controller) {
      if (active.get(key) === controller) {
        active.delete(key);
      }
    },

    /** @param {number} key @param {string} cacheKey @param {boolean} [force] */
    getReusable(key, cacheKey, force = false) {
      const entry = reusable.get(key);
      return !force && entry?.cacheKey === cacheKey ? entry.components : undefined;
    },

    /**
     * @param {number} key
     * @param {AbortController} controller
     * @param {string} cacheKey
     * @param {ReadonlyArray<any>} components
     */
    retain(key, controller, cacheKey, components) {
      if (active.get(key) !== controller) {
        return false;
      }
      reusable.set(key, { cacheKey, components });
      return true;
    },
  };
};

module.exports = { createWalkthroughGenerationCoordinator, SUPERSEDED_GENERATION_REASON };
