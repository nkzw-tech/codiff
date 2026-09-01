// @ts-check

const createRepositoryStateRequestCoordinator = () => {
  /** @type {Map<number, {generation: number}>} */
  const windows = new Map();

  return {
    /** @param {number} webContentsId */
    clear(webContentsId) {
      windows.delete(webContentsId);
    },
    /**
     * @template T
     * @param {number} webContentsId
     * @param {() => Promise<T>} read
     * @param {(state: T) => void} accept
     * @param {() => boolean} [isActive]
     */
    async resolve(webContentsId, read, accept, isActive = () => true) {
      const window = windows.get(webContentsId) ?? { generation: 0 };
      window.generation += 1;
      windows.set(webContentsId, window);
      const generation = window.generation;
      const state = await read();
      if (windows.get(webContentsId) === window && window.generation === generation && isActive()) {
        accept(state);
      }
      return state;
    },
  };
};

module.exports = { createRepositoryStateRequestCoordinator };
