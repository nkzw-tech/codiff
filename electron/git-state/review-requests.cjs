// @ts-check

const { parseRemoteUrl, parseReviewRemotes, parseReviewUrl } = require('../review-source.cjs');
const { git, gitOrEmpty } = require('./common.cjs');
const { glabApi } = require('./merge-request.cjs');
const { ghApi } = require('./pull-request.cjs');

/** @typedef {import('../../core/types.ts').ReviewProject} ReviewProject */
/** @typedef {import('../../core/types.ts').ReviewRequestListQuery} ReviewRequestListQuery */
/** @typedef {import('../../core/types.ts').ReviewRequestPage} ReviewRequestPage */
/** @typedef {import('../../core/types.ts').ReviewRequestSummary} ReviewRequestSummary */

const PAGE_SIZE = 35;

/** @param {string} repoRoot @returns {Promise<Array<ReviewProject>>} */
const readReviewProjects = async (repoRoot) => {
  const [raw, names] = await Promise.all([
    git(repoRoot, ['remote', '-v']),
    git(repoRoot, ['remote']),
  ]);
  const remotes = new Map(
    parseReviewRemotes(raw)
      .filter((remote) => remote.direction === 'fetch')
      .map((remote) => [remote.name, remote]),
  );
  const orderedNames = names
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort((left, right) => Number(right === 'origin') - Number(left === 'origin'));

  const candidates = await Promise.all(
    orderedNames.map(async (remote) => {
      // A Git rewrite may point GitHub at an SSH alias or a local mirror.
      const configuredUrl = await gitOrEmpty(repoRoot, ['config', '--get', `remote.${remote}.url`]);
      const configured = parseRemoteUrl(configuredUrl.trim());
      const project = configured?.provider === 'github' ? configured : remotes.get(remote);
      return project ? { ...project, remote } : null;
    }),
  );

  const projects = new Map();
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const { host, projectPath, provider, remote } = candidate;
    if (
      !/^[\w.-]+(?::\d+)?$/.test(host) ||
      !/^[\w.-]+(?:\/[\w.-]+)+$/.test(projectPath) ||
      projectPath.split('/').some((part) => part === '.' || part === '..') ||
      (provider === 'github' && projectPath.split('/').length !== 2)
    ) {
      continue;
    }
    const id = `${provider}:${host}/${projectPath.toLowerCase()}`;
    if (!projects.has(id)) {
      projects.set(id, { host, id, path: projectPath, provider, remote });
    }
  }
  return [...projects.values()];
};

/**
 * @param {{url: string; title: string; updatedAt: string; state: ReviewRequestSummary['state']; draft?: boolean; author?: string}} entry
 * @returns {ReviewRequestSummary | null}
 */
const normalizeEntry = ({ url, title, updatedAt, state, draft, author }) => {
  const parsed = parseReviewUrl(url);
  const timestamp = Date.parse(updatedAt);
  if (!parsed || !Number.isFinite(timestamp)) {
    return null;
  }
  return {
    author,
    draft: state === 'open' && Boolean(draft),
    source: {
      host: parsed.host,
      number: parsed.number,
      projectPath: parsed.projectPath,
      provider: parsed.provider,
      title,
      type: 'pull-request',
      url: parsed.url,
    },
    state,
    updatedAt: timestamp,
  };
};

const pullRequestFields = 'number title url updatedAt state isDraft author { login }';
const connectionFields = 'pageInfo { hasNextPage endCursor }';

/**
 * @param {string} repoRoot
 * @param {ReviewProject} project
 * @param {ReviewRequestListQuery} query
 * @param {string | undefined} number
 * @returns {Promise<ReviewRequestPage>}
 */
const listGitHubRequests = async (repoRoot, project, { cursor, filter, search, sort }, number) => {
  const [owner, name] = project.path.split('/');
  if (number) {
    let entry;
    try {
      entry = JSON.parse(
        await ghApi(repoRoot, [
          '--hostname',
          project.host,
          `repos/${project.path}/pulls/${number}`,
        ]),
      );
    } catch (error) {
      if (error instanceof Error && /\(HTTP 404\)/.test(error.message)) {
        return { entries: [] };
      }
      throw error;
    }
    const state = entry.merged ? 'merged' : entry.state === 'closed' ? 'closed' : 'open';
    const summary = normalizeEntry({
      author: entry.user?.login,
      draft: entry.draft,
      state,
      title: entry.title,
      updatedAt: entry.updated_at,
      url: entry.html_url,
    });
    return { entries: summary && (filter === 'all' || filter === state) ? [summary] : [] };
  }

  const direction = sort === 'oldest' ? 'ASC' : 'DESC';
  const field = sort === 'updated' ? 'UPDATED_AT' : 'CREATED_AT';
  const payload = search
    ? {
        query: `query($search: String!, $after: String, $first: Int!) {
          search(type: ISSUE, query: $search, after: $after, first: $first) {
            nodes { ... on PullRequest { ${pullRequestFields} } }
            ${connectionFields}
          }
        }`,
        variables: {
          after: cursor,
          first: PAGE_SIZE,
          search: [
            `repo:${project.path}`,
            'is:pr',
            ...(filter === 'all'
              ? []
              : [`is:${filter === 'closed' ? 'unmerged is:closed' : filter}`]),
            'in:title',
            `sort:${sort === 'updated' ? 'updated' : 'created'}-${direction.toLowerCase()}`,
            // Quote each term so text stays inside the chosen repository and filters.
            ...search
              .replaceAll(/["\\]/g, ' ')
              .split(/\s+/)
              .filter(Boolean)
              .map((term) => `"${term}"`),
          ].join(' '),
        },
      }
    : {
        query: `query($owner: String!, $name: String!, $states: [PullRequestState!], $order: IssueOrder!, $after: String, $first: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequests(states: $states, orderBy: $order, after: $after, first: $first) {
              nodes { ${pullRequestFields} }
              ${connectionFields}
            }
          }
        }`,
        variables: {
          after: cursor,
          first: PAGE_SIZE,
          name,
          order: { direction, field },
          owner,
          states: filter === 'all' ? ['OPEN', 'CLOSED', 'MERGED'] : [filter.toUpperCase()],
        },
      };

  const { data } = JSON.parse(
    await ghApi(repoRoot, ['graphql', '--hostname', project.host, '--input', '-'], payload),
  );
  const connection = search ? data.search : data.repository.pullRequests;
  /** @type {Array<ReviewRequestSummary>} */
  const entries = [];
  for (const entry of connection.nodes) {
    if (!entry?.url) {
      continue;
    }
    const summary = normalizeEntry({
      author: entry.author?.login,
      draft: entry.isDraft,
      state: entry.state === 'MERGED' ? 'merged' : entry.state === 'CLOSED' ? 'closed' : 'open',
      title: entry.title,
      updatedAt: entry.updatedAt,
      url: entry.url,
    });
    if (summary) {
      entries.push(summary);
    }
  }
  return {
    entries,
    nextCursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined,
  };
};

/**
 * @param {string} repoRoot
 * @param {ReviewProject} project
 * @param {ReviewRequestListQuery} query
 * @param {string | undefined} number
 * @returns {Promise<ReviewRequestPage>}
 */
const listGitLabRequests = async (repoRoot, project, { cursor, filter, search, sort }, number) => {
  const page = cursor ? Number(cursor) : 1;
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error('Invalid merge request page.');
  }
  const params = new URLSearchParams({
    order_by: sort === 'updated' ? 'updated_at' : 'created_at',
    page: String(page),
    per_page: String(PAGE_SIZE),
    scope: 'all',
    sort: sort === 'oldest' ? 'asc' : 'desc',
    state: filter === 'open' ? 'opened' : filter,
  });
  if (number) {
    params.set('iids[]', number);
  } else if (search) {
    params.set('search', search);
    params.set('in', 'title');
  }
  const results = JSON.parse(
    await glabApi(repoRoot, project, [
      `projects/${encodeURIComponent(project.path)}/merge_requests?${params}`,
    ]),
  );
  /** @type {Array<ReviewRequestSummary>} */
  const entries = [];
  for (const entry of results) {
    const summary = normalizeEntry({
      author: entry.author?.username,
      draft: entry.draft ?? entry.work_in_progress,
      state: entry.state === 'merged' ? 'merged' : entry.state === 'closed' ? 'closed' : 'open',
      title: entry.title,
      updatedAt: entry.updated_at,
      url: entry.web_url,
    });
    if (summary) {
      entries.push(summary);
    }
  }
  return { entries, nextCursor: results.length === PAGE_SIZE ? String(page + 1) : undefined };
};

/** @param {string} repoRoot @param {ReviewRequestListQuery} query */
const listReviewRequests = async (repoRoot, query) => {
  if (
    !query ||
    !['all', 'open', 'merged', 'closed'].includes(query.filter) ||
    !['newest', 'oldest', 'updated'].includes(query.sort) ||
    typeof query.search !== 'string' ||
    (query.cursor != null && typeof query.cursor !== 'string')
  ) {
    throw new Error('Invalid review list query.');
  }

  const projects = await readReviewProjects(repoRoot);
  const project = projects.find(({ id }) => id === query.projectId);
  if (!project) {
    throw new Error('This review project is no longer a remote of the current repository.');
  }

  const search = query.search.trim().slice(0, 200);
  const number = search.match(/^[#!]?([1-9]\d{0,9})$/)?.[1];
  return (project.provider === 'github' ? listGitHubRequests : listGitLabRequests)(
    repoRoot,
    project,
    { ...query, search },
    number,
  );
};

module.exports = { listReviewRequests, readReviewProjects };
