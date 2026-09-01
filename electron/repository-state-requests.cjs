// @ts-check

const createRepositoryStateRequestCoordinator = () => {
  /** @type {Map<number, number>} */
  const generations = new Map();

  return {
    /**
     * @template T
     * @param {number} webContentsId
     * @param {() => Promise<T>} read
     * @param {(state: T) => void} accept
     */
    async resolve(webContentsId, read, accept) {
      const generation = (generations.get(webContentsId) ?? 0) + 1;
      generations.set(webContentsId, generation);
      const state = await read();
      if (generations.get(webContentsId) === generation) {
        accept(state);
      }
      return state;
    },
  };
};

module.exports = { createRepositoryStateRequestCoordinator };
