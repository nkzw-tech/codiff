// @ts-check

/**
 * CJS bridge to @nkzw/codiff-gitlab (ESM).
 */

const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const { createImmutableCache } = require('./immutable-cache.cjs');

/** @type {Promise<typeof import('../gitlab/dist/index.mjs')> | null} */
let modulePromise = null;
const readImmutableVersionTimeline = createImmutableCache();
const readImmutableDiscussions = createImmutableCache();
const MAX_SHARED_REVIEW_DISCUSSIONS_BYTES = 8 * 1024 * 1024;

const loadGitLabHistory = () => {
  if (!modulePromise) {
    const modulePath = join(__dirname, '../gitlab/dist/index.mjs');
    modulePromise = import(pathToFileURL(modulePath).href);
  }
  return modulePromise;
};

/**
 * Share the immutable version timeline between the provider comment adapter
 * and the review-history adapter. The review head participates in the key so
 * a refreshed source can discover newly-created GitLab versions.
 *
 * @param {{headSha?: string, host?: string, number: number, projectPath: string}} source
 * @param {import('../gitlab/src/history.ts').GitLabTransport} transport
 */
const loadGitLabReviewVersionTimeline = (source, transport) =>
  readImmutableVersionTimeline(
    `${source.host || 'gitlab'}:${source.projectPath}:!${source.number}:${source.headSha || 'unknown-head'}:versions`,
    async () => {
      const gitlab = await loadGitLabHistory();
      return gitlab.fetchGitLabReviewVersionTimeline({
        iid: source.number,
        projectPath: source.projectPath,
        transport,
      });
    },
  );

/**
 * Share discussion evidence used both for rendered review comments and for
 * deferred reviewer-activity enrichment.
 *
 * @param {{headSha?: string, host?: string, number: number, projectPath: string}} source
 * @param {import('../gitlab/src/history.ts').GitLabTransport} transport
 */
const loadGitLabReviewDiscussions = (source, transport) =>
  readImmutableDiscussions(
    `${source.host || 'gitlab'}:${source.projectPath}:!${source.number}:${source.headSha || 'unknown-head'}:discussions`,
    () =>
      transport.requestPages({
        maxBytes: MAX_SHARED_REVIEW_DISCUSSIONS_BYTES,
        path: `projects/${encodeURIComponent(source.projectPath)}/merge_requests/${source.number}/discussions`,
      }),
  );

module.exports = {
  loadGitLabHistory,
  loadGitLabReviewDiscussions,
  loadGitLabReviewVersionTimeline,
};
