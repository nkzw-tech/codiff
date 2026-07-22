// @ts-check

const { basename } = require('node:path');
const { parseReviewUrl } = require('./review-source.cjs');

/** @param {import('../core/types.ts').ReviewSource} source */
const getWindowSourceTitle = (source) =>
  source.type === 'working-tree'
    ? null
    : source.type === 'pull-request'
      ? String(source.number ?? parseReviewUrl(source.url)?.number ?? 'PR')
      : source.type === 'commit'
        ? source.ref.slice(0, 7)
        : source.type === 'range'
          ? `${source.base}${source.symmetric ? '...' : '..'}${source.head}`
          : source.ref;

/**
 * @param {import('../core/types.ts').RepositoryState} state
 */
const getRepositoryWindowTitle = (state) => {
  // Use the resolved source so aliases such as HEAD and a PR URL become the view the user opened.
  const sourceTitle = getWindowSourceTitle(state.source);
  return `Codiff – ${basename(state.root)}${sourceTitle ? `/${sourceTitle}` : ''}`;
};

module.exports = { getRepositoryWindowTitle };
