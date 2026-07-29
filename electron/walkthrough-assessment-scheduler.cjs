// @ts-check

const { randomUUID } = require('node:crypto');

/** @param {unknown} value */
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

/** @param {import('../core/types.ts').AssessmentIdentity} identity */
const identityKey = (identity) => JSON.stringify(stableValue(identity));

/**
 * Keep pending assessment claims transient, latest-request-wins, and bounded
 * across every local walkthrough request.
 *
 * @param {{
 *   concurrency?: number,
 *   replace: (cacheKey: string, replacement: {
 *     component: import('../core/types.ts').AssessmentComponent,
 *     expectedComponent: import('../core/types.ts').AssessmentComponent | null,
 *   }) => {status: string, walkthrough: import('../core/types.ts').WalkthroughArtifactV5 | null},
 * }} dependencies
 */
const createWalkthroughAssessmentScheduler = ({ concurrency = 3, replace }) => {
  const claims = new Map();
  const queue = [];
  let active = 0;

  const drain = () => {
    while (active < concurrency && queue.length > 0) {
      const task = queue.shift();
      active += 1;
      void task().finally(() => {
        active -= 1;
        drain();
      });
    }
  };

  /**
   * @param {{
   *   cacheKey: string,
   *   demand: import('../core/lib/walkthrough-assessment-cache.ts').AssessmentDemand,
   *   expectedComponent: import('../core/types.ts').AssessmentComponent | null,
   *   generate: () => Promise<import('../core/types.ts').AssessmentComponent>,
   *   onUpdate: (walkthrough: import('../core/types.ts').WalkthroughArtifactV5) => void,
   * }} input
   */
  const schedule = (input) => {
    const key = `${input.cacheKey}:${identityKey(input.demand.identity)}`;
    const token = randomUUID();
    claims.set(key, token);
    return new Promise((resolve) => {
      queue.push(async () => {
        try {
          if (claims.get(key) !== token) {
            resolve({ status: 'stale' });
            return;
          }
          const component = await input.generate();
          if (claims.get(key) !== token) {
            resolve({ status: 'stale' });
            return;
          }
          const result = replace(input.cacheKey, {
            component,
            expectedComponent: input.expectedComponent,
          });
          if (result.status === 'replaced' && result.walkthrough) {
            input.onUpdate(result.walkthrough);
          }
          resolve(result);
        } catch (error) {
          resolve({ error, status: 'failed' });
        } finally {
          if (claims.get(key) === token) {
            claims.delete(key);
          }
        }
      });
      drain();
    });
  };

  return { schedule };
};

module.exports = { createWalkthroughAssessmentScheduler };
