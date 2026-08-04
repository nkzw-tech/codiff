// @ts-check

/**
 * Create an immutable completed-value cache with optional in-flight sharing.
 * Disabling sharing leaves completed reuse intact while allowing one caller
 * to cancel without coupling a later request to the same promise.
 */
const createImmutableCache = () => {
  const completed = new Map();
  const inFlight = new Map();

  /**
   * @param {string} key
   * @param {() => Promise<any>} load
   * @param {{shareInFlight?: boolean}} [options]
   */
  return (key, load, options = {}) => {
    if (completed.has(key)) {
      return Promise.resolve(completed.get(key));
    }
    const shareInFlight = options.shareInFlight !== false;
    if (shareInFlight) {
      const active = inFlight.get(key);
      if (active) {
        return active;
      }
    }

    const pending = Promise.resolve()
      .then(load)
      .then((value) => {
        completed.set(key, value);
        return value;
      });
    if (!shareInFlight) {
      return pending;
    }

    const shared = pending.then(
      (value) => {
        if (inFlight.get(key) === shared) {
          inFlight.delete(key);
        }
        return value;
      },
      (error) => {
        if (inFlight.get(key) === shared) {
          inFlight.delete(key);
        }
        throw error;
      },
    );
    inFlight.set(key, shared);
    return shared;
  };
};

module.exports = { createImmutableCache };
