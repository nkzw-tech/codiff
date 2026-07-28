// @ts-nocheck

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value != null && !Array.isArray(value);
/** @param {unknown} value */
const isOptionalString = (value) => value == null || typeof value === 'string';
/** @param {unknown} value */
const isOptionalNumber = (value) => value == null || typeof value === 'number';

/** @param {string} value */
const parseReviewUrl = (value) => {
  try {
    const url = new globalThis.URL(value);
    const host = url.hostname.toLowerCase();
    const github = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i);
    if (github) {
      const owner = github[1];
      const repo = github[2].replace(/\.git$/i, '');
      const number = Number(github[3]);
      return {
        host,
        number,
        owner,
        projectPath: `${owner}/${repo}`,
        provider: /** @type {const} */ ('github'),
        repo,
        url: `${url.protocol}//${url.host}/${owner}/${repo}/pull/${number}`,
      };
    }
    const gitlab = url.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/.*)?$/i);
    if (gitlab) {
      const projectPath = gitlab[1].replace(/\.git$/i, '');
      const number = Number(gitlab[2]);
      return {
        host,
        number,
        projectPath,
        provider: /** @type {const} */ ('gitlab'),
        url: `${url.protocol}//${url.host}/${projectPath}/-/merge_requests/${number}`,
      };
    }
  } catch {
    // Invalid and non-review URLs are rejected by the codec.
  }
  return null;
};

/** @param {Record<string, unknown>} value */
const decodePullRequestSource = (value) => {
  if (
    typeof value.url !== 'string' ||
    !isOptionalNumber(value.number) ||
    !isOptionalString(value.headSha) ||
    !isOptionalString(value.host) ||
    !isOptionalString(value.owner) ||
    !isOptionalString(value.projectPath) ||
    !isOptionalString(value.repo) ||
    !isOptionalString(value.title)
  ) {
    return null;
  }
  const parsed = parseReviewUrl(value.url);
  const provider = value.provider || parsed?.provider;
  if (provider !== 'github' && provider !== 'gitlab') {
    return null;
  }
  return {
    ...value,
    ...(parsed || {}),
    ...(typeof value.headSha === 'string' ? { headSha: value.headSha.toLowerCase() } : {}),
    provider,
    type: /** @type {const} */ ('pull-request'),
  };
};

/** @param {unknown} input */
const decodeReviewSource = (input) => {
  if (!isObject(input) || typeof input.type !== 'string') {
    return null;
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  if (value.type === 'working-tree') {
    return { type: /** @type {const} */ ('working-tree') };
  }
  if (value.type === 'commit') {
    return typeof value.ref === 'string'
      ? { ref: value.ref, type: /** @type {const} */ ('commit') }
      : null;
  }
  if (value.type === 'branch') {
    return typeof value.ref === 'string'
      ? { ref: value.ref, type: /** @type {const} */ ('branch') }
      : null;
  }
  if (value.type === 'branch-diff') {
    return typeof value.ref === 'string' &&
      typeof value.baseSha === 'string' &&
      typeof value.headSha === 'string'
      ? {
          baseSha: value.baseSha.toLowerCase(),
          headSha: value.headSha.toLowerCase(),
          ref: value.ref,
          type: /** @type {const} */ ('branch-diff'),
        }
      : null;
  }
  if (value.type === 'branch-working-tree') {
    if (
      typeof value.ref !== 'string' ||
      !isOptionalString(value.baseSha) ||
      !isOptionalString(value.headSha)
    ) {
      return null;
    }
    const hasBase = typeof value.baseSha === 'string' && value.baseSha.length > 0;
    const hasHead = typeof value.headSha === 'string' && value.headSha.length > 0;
    if (hasBase !== hasHead) {
      return null;
    }
    return {
      ...(hasBase
        ? { baseSha: value.baseSha.toLowerCase(), headSha: value.headSha.toLowerCase() }
        : {}),
      ref: value.ref,
      type: /** @type {const} */ ('branch-working-tree'),
    };
  }
  if (value.type === 'range') {
    return typeof value.base === 'string' &&
      typeof value.head === 'string' &&
      typeof value.symmetric === 'boolean'
      ? {
          base: value.base,
          head: value.head,
          symmetric: value.symmetric,
          type: /** @type {const} */ ('range'),
        }
      : null;
  }
  return value.type === 'pull-request' ? decodePullRequestSource(value) : null;
};

/** @param {unknown} input */
const decodeResolvedReviewSource = (input) => {
  if (!isObject(input) || typeof input.type !== 'string') {
    return null;
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  if (value.type === 'commit') {
    return typeof value.sha === 'string'
      ? { sha: value.sha.toLowerCase(), type: /** @type {const} */ ('commit') }
      : null;
  }
  const source = decodeReviewSource(input);
  if (!source || source.type === 'branch') {
    return null;
  }
  if (
    source.type === 'branch-working-tree' &&
    (!('baseSha' in source) || !source.baseSha || !source.headSha)
  ) {
    return null;
  }
  return source;
};

/** @param {ReturnType<typeof decodeReviewSource> | ReturnType<typeof decodeResolvedReviewSource>} source */
const formatReviewSourceIdentity = (source) => {
  if (!source) {
    return null;
  }
  if (source.type === 'working-tree') {
    return 'working-tree';
  }
  if (source.type === 'commit') {
    return `commit:${'sha' in source ? source.sha : source.ref}`;
  }
  if (source.type === 'branch') {
    return `branch:${source.ref}`;
  }
  if (source.type === 'branch-diff') {
    return `branch-diff:${source.ref}:${source.baseSha}:${source.headSha}`;
  }
  if (source.type === 'branch-working-tree') {
    return 'baseSha' in source && source.baseSha && source.headSha
      ? `branch-working-tree:${source.ref}:${source.baseSha}:${source.headSha}`
      : `branch-working-tree:${source.ref}:unresolved`;
  }
  if (source.type === 'range') {
    return `range:${source.base}${source.symmetric ? '...' : '..'}${source.head}`;
  }
  const parsed = parseReviewUrl(source.url);
  const provider = source.provider || parsed?.provider || '';
  const host = (source.host || parsed?.host || '').toLowerCase();
  const projectPath = (
    source.projectPath ||
    (source.owner && source.repo ? `${source.owner}/${source.repo}` : parsed?.projectPath) ||
    ''
  ).toLowerCase();
  return `pull-request:${provider}:${host}:${projectPath}#${source.number || parsed?.number || source.url}`;
};

/** @param {ReturnType<typeof decodeResolvedReviewSource>} source */
const formatResolvedSourceIdentity = (source) => {
  const logical = formatReviewSourceIdentity(source);
  return logical && source?.type === 'pull-request'
    ? `${logical}:${source.headSha || 'unresolved-head'}`
    : logical;
};

// eslint-disable-next-line no-undef
module.exports = {
  decodeResolvedReviewSource,
  decodeReviewSource,
  formatResolvedSourceIdentity,
  formatReviewSourceIdentity,
  parseReviewUrl,
};
