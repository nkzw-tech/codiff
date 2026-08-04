#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import {
  captureOptionalProviderRoute,
  sanitizeProviderTranscript,
} from '../evals/provider-mock-capture.mjs';
import { materializeReviewScenario, reviewScenarios } from '../test-scenarios/review/index.mjs';
import { resolveSubmissionAnchor } from '../test-scenarios/submission-anchors.mjs';
import { getSubmissionPlan } from '../test-scenarios/submission/index.mjs';
import { runScenarioCommand } from './test-scenario-command.mjs';
import { assertReusableStatePath, createStatePersistence } from './test-scenario-state.mjs';

const require = createRequire(import.meta.url);
const {
  submitPullRequestComment,
  submitPullRequestReview,
} = require('../electron/git-state/pull-request.cjs');
const {
  submitMergeRequestComment,
  submitMergeRequestReview,
} = require('../electron/git-state/merge-request.cjs');

const STATE_FILE = 'codiff-test-scenarios.json';
const usage = () => {
  process.stdout.write(`Usage:
  node scripts/test-scenarios.mjs create-scenarios [--providers github,gitlab] [--scenarios current-commit-stack,unstructured-commits] [--github-owner OWNER] [--gitlab-host HOST] [--gitlab-namespace NAMESPACE] [--state PATH]
  node scripts/test-scenarios.mjs status --state PATH
  node scripts/test-scenarios.mjs open --state PATH --provider github|gitlab --scenario SCENARIO [--walkthrough]
  node scripts/test-scenarios.mjs record-mocks --state PATH [--providers github,gitlab] [--scenarios SCENARIO,...]
  node scripts/test-scenarios.mjs run-tests --state PATH [--providers github,gitlab] [--scenarios SCENARIO,...]
  node scripts/test-scenarios.mjs destroy --state PATH --yes

create-scenarios makes private reusable repositories and PRs/MRs for every
requested scenario. It prints Codiff commands and writes a state file used by
status, open, record-mocks, run-tests, and destroy.
`);
};

const parseArguments = (args) => {
  const values = new Map();
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const [key, inline] = value.slice(2).split('=', 2);
    if (inline != null) {
      values.set(key, inline);
    } else if (key === 'yes' || key === 'walkthrough') {
      values.set(key, 'true');
    } else {
      values.set(key, args[index + 1] ?? '');
      index += 1;
    }
  }
  return { positional, values };
};

const command = (cwd, executable, args, options = {}) =>
  runScenarioCommand({ args, cwd, executable, ...options });

const git = (cwd, ...args) => command(cwd, 'git', args);

const repositorySlug = (scenarioId) => `codiff-test-scenario-v3-${scenarioId}`;
const scenarioBranch = (kind, runId) => `codiff-scenario-${kind}-${runId}`;

const resolveGitLabNamespace = async (host, explicitNamespace) => {
  if (explicitNamespace) {
    return explicitNamespace;
  }
  const user = JSON.parse(
    await command(process.cwd(), 'glab', ['api', '--hostname', host, 'user'], { capture: true }),
  );
  if (typeof user.username !== 'string' || !user.username) {
    throw new Error('Could not determine the authenticated GitLab personal namespace.');
  }
  return user.username;
};

const resolveGitHubOwner = async (explicitOwner) => {
  if (explicitOwner) {
    return explicitOwner;
  }
  const user = JSON.parse(await command(process.cwd(), 'gh', ['api', 'user'], { capture: true }));
  if (typeof user.login !== 'string' || !user.login) {
    throw new Error('Could not determine the authenticated GitHub owner.');
  }
  return user.login;
};

const commandOrNull = async (...args) => {
  try {
    return await command(...args);
  } catch {
    return null;
  }
};

const closeGitHubReviews = async (repository) => {
  const output = await commandOrNull(
    process.cwd(),
    'gh',
    ['pr', 'list', '--repo', repository, '--state', 'open', '--json', 'number'],
    { capture: true },
  );
  if (!output) {
    return;
  }
  for (const review of JSON.parse(output)) {
    await command(process.cwd(), 'gh', [
      'pr',
      'close',
      String(review.number),
      '--repo',
      repository,
      '--delete-branch',
    ]);
  }
};

const closeGitLabReviews = async (review) => {
  const host = new URL(review.url).host;
  const output = await commandOrNull(
    process.cwd(),
    'glab',
    [
      'api',
      '--hostname',
      host,
      `projects/${encodeURIComponent(review.repository)}/merge_requests?state=opened&per_page=100`,
    ],
    { capture: true },
  );
  if (!output) {
    return;
  }
  for (const mergeRequest of JSON.parse(output)) {
    await command(process.cwd(), 'glab', [
      'api',
      '--hostname',
      host,
      '--method',
      'PUT',
      `projects/${encodeURIComponent(review.repository)}/merge_requests/${mergeRequest.iid}`,
      '--raw-field',
      'state_event=close',
    ]);
  }
};

const publishScenario = async ({
  baseBranch,
  createReview,
  directory,
  featureBranch,
  scenarioId,
}) => {
  const runGit = (args) => command(directory, 'git', args, { capture: true });
  const result = await materializeReviewScenario({
    baseBranch,
    featureBranch,
    onCheckpoint: async ({ kind }) => {
      if (kind === 'base-ready') {
        await runGit(['push', '--set-upstream', 'origin', baseBranch]);
      }
    },
    root: process.cwd(),
    runGit,
    scenarioId,
  });
  await runGit(['push', '--set-upstream', 'origin', featureBranch]);
  const url = await createReview();
  const headSha = await runGit(['rev-parse', 'HEAD']);
  return { baseSha: result.revisions.base, headSha, revisions: result.revisions, url };
};

const createGitHub = async ({
  baseBranch,
  directory,
  featureBranch,
  onResourceReady,
  owner,
  scenarioId,
  slug,
}) => {
  await git(directory, 'init');
  const repository = `${owner}/${slug}`;
  const existing = await commandOrNull(directory, 'gh', ['repo', 'view', repository], {
    capture: true,
  });
  if (existing) {
    await closeGitHubReviews(repository);
    await git(directory, 'remote', 'add', 'origin', `git@github.com:${repository}.git`);
  } else {
    await command(directory, 'gh', [
      'repo',
      'create',
      repository,
      '--private',
      '--disable-wiki',
      '--source',
      '.',
      '--remote',
      'origin',
    ]);
  }
  await onResourceReady({
    baseBranch,
    creationStatus: 'partial',
    featureBranch,
    provider: 'github',
    repository,
    scenario: scenarioId,
    url: `https://github.com/${repository}`,
    worktree: directory,
  });
  const { baseSha, headSha, revisions, url } = await publishScenario({
    baseBranch,
    createReview: () =>
      command(
        directory,
        'gh',
        [
          'pr',
          'create',
          '--base',
          baseBranch,
          '--head',
          featureBranch,
          '--title',
          `Codiff ${scenarioId} smoke`,
          '--body',
          'Disposable Codiff test scenario.',
        ],
        { capture: true },
      ),
    directory,
    featureBranch,
    scenarioId,
  });
  return {
    baseBranch,
    baseSha,
    featureBranch,
    headSha,
    provider: 'github',
    repository,
    revisions,
    scenario: scenarioId,
    url,
    worktree: directory,
  };
};

const createGitLab = async ({
  baseBranch,
  directory,
  featureBranch,
  host,
  namespace,
  onResourceReady,
  scenarioId,
  slug,
}) => {
  await git(directory, 'init');
  const repository = `${namespace}/${slug}`;
  const existing = await commandOrNull(
    directory,
    'glab',
    ['api', '--hostname', host, `projects/${encodeURIComponent(repository)}`],
    { capture: true },
  );
  if (existing) {
    await closeGitLabReviews({
      repository,
      url: `https://${host}/${repository}/-/merge_requests/1`,
    });
  } else {
    await command(
      directory,
      'glab',
      ['repo', 'create', repository, '--private', '--defaultBranch', 'main', '--skipGitInit'],
      { env: { GITLAB_HOST: host } },
    );
  }
  try {
    await git(directory, 'remote', 'get-url', 'origin');
  } catch {
    await git(directory, 'remote', 'add', 'origin', `git@${host}:${namespace}/${slug}.git`);
  }
  await onResourceReady({
    baseBranch,
    creationStatus: 'partial',
    featureBranch,
    provider: 'gitlab',
    repository,
    scenario: scenarioId,
    url: `https://${host}/${repository}`,
    worktree: directory,
  });
  const { baseSha, headSha, revisions, url } = await publishScenario({
    baseBranch,
    createReview: () =>
      command(
        directory,
        'glab',
        [
          'mr',
          'create',
          '--source-branch',
          featureBranch,
          '--target-branch',
          baseBranch,
          '--title',
          `Codiff ${scenarioId} smoke`,
          '--description',
          'Disposable Codiff test scenario.',
          '--yes',
        ],
        { capture: true, env: { GITLAB_HOST: host } },
      ),
    directory,
    featureBranch,
    scenarioId,
  });
  return {
    baseBranch,
    baseSha,
    featureBranch,
    headSha,
    provider: 'gitlab',
    repository,
    revisions,
    scenario: scenarioId,
    url,
    worktree: directory,
  };
};

const readState = async (path) => JSON.parse(await readFile(path, 'utf8'));

const runGit = (directory, args) => command(directory, 'git', args, { capture: true });

const reviewNumber = (url) => {
  const value = Number(new URL(url).pathname.split('/').filter(Boolean).at(-1));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Could not determine review number from ${url}.`);
  }
  return value;
};

const printCodiffCommands = (state) => {
  for (const review of state.reviews) {
    process.stdout.write(
      `\n${review.provider}: ${review.url}\n` +
        `  pnpm exec codiff "${review.url}" "${review.worktree}"\n` +
        `  pnpm exec codiff --walkthrough "${review.url}" "${review.worktree}"\n`,
    );
  }
};

const createScenarios = async (values) => {
  const providers = (values.get('providers') ?? 'github,gitlab')
    .split(',')
    .map((provider) => provider.trim())
    .filter(Boolean);
  const unsupported = providers.filter(
    (provider) => provider !== 'github' && provider !== 'gitlab',
  );
  if (unsupported.length) {
    throw new Error(`Unsupported provider(s): ${unsupported.join(', ')}`);
  }
  if (providers.length === 0) {
    throw new Error('At least one provider is required.');
  }
  const scenarios = (values.get('scenarios') ?? Object.keys(reviewScenarios).join(','))
    .split(',')
    .map((scenarioId) => scenarioId.trim())
    .filter(Boolean);
  const unknownScenarios = scenarios.filter((scenarioId) => !reviewScenarios[scenarioId]);
  if (unknownScenarios.length) {
    throw new Error(`Unknown scenario(s): ${unknownScenarios.join(', ')}`);
  }
  if (scenarios.length === 0) {
    throw new Error('At least one scenario is required.');
  }
  const host = values.get('gitlab-host') || process.env.GITLAB_HOST;
  if (providers.includes('gitlab') && !host) {
    throw new Error('GitLab scenarios require --gitlab-host HOST or GITLAB_HOST.');
  }
  const namespace = providers.includes('gitlab')
    ? await resolveGitLabNamespace(host, values.get('gitlab-namespace'))
    : null;
  const githubOwner = providers.includes('github')
    ? await resolveGitHubOwner(values.get('github-owner'))
    : null;
  const explicitStatePath = values.get('state') ? resolve(values.get('state')) : null;
  if (explicitStatePath) {
    await assertReusableStatePath(explicitStatePath);
    await mkdir(dirname(explicitStatePath), { recursive: true });
  }
  const root = await mkdtemp(join(tmpdir(), 'codiff-test-scenarios-'));
  const runId = new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, '')
    .slice(0, 14);
  const statePath = explicitStatePath ?? resolve(join(root, STATE_FILE));
  const state = { createdAt: new Date().toISOString(), reviews: [], root, version: 2 };
  const persistReview = createStatePersistence(statePath, state);
  for (const scenarioId of scenarios) {
    const slug = repositorySlug(scenarioId);
    const baseBranch = scenarioBranch('base', runId);
    const featureBranch = scenarioBranch('feature', runId);
    if (githubOwner) {
      const directory = join(root, 'github', scenarioId);
      await mkdir(directory, { recursive: true });
      const review = await createGitHub({
        baseBranch,
        directory,
        featureBranch,
        onResourceReady: persistReview,
        owner: githubOwner,
        scenarioId,
        slug,
      });
      await persistReview(review);
    }
    if (namespace) {
      const directory = join(root, 'gitlab', scenarioId);
      await mkdir(directory, { recursive: true });
      const review = await createGitLab({
        baseBranch,
        directory,
        featureBranch,
        host,
        namespace,
        onResourceReady: persistReview,
        scenarioId,
        slug,
      });
      await persistReview(review);
    }
  }
  process.stdout.write(`Created smoke state: ${statePath}\n`);
  printCodiffCommands(state);
};

const scenarioFilters = (values, name, fallback) =>
  (values.get(name) ?? fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const githubJson = (review, resource) =>
  command(review.worktree, 'gh', ['api', resource], { capture: true }).then(JSON.parse);

const gitlabJson = (review, resource) => {
  const host = new URL(review.url).host;
  return command(review.worktree, 'glab', ['api', '--hostname', host, resource], {
    capture: true,
  }).then(JSON.parse);
};

const captureGitHubTranscript = async (review) => {
  const [owner, repository] = review.repository.split('/', 2);
  const root = `repos/${owner}/${repository}`;
  const comparePath = `/${root}/compare/${review.baseSha}...${review.headSha}`;
  const compare = await githubJson(review, comparePath.slice(1));
  const routes = [
    {
      path: comparePath,
      query: { page: 1, per_page: 100 },
      response: compare,
    },
    {
      path: '/user',
      response: await githubJson(review, 'user'),
    },
    {
      path: `/${root}/pulls/${reviewNumber(review.url)}`,
      response: await githubJson(review, `${root}/pulls/${reviewNumber(review.url)}`),
    },
  ];
  for (const commit of compare.commits ?? []) {
    if (typeof commit.sha !== 'string') {
      continue;
    }
    const path = `/${root}/commits/${commit.sha}`;
    routes.push({
      path,
      query: { page: 1, per_page: 100 },
      response: await githubJson(review, path.slice(1)),
    });
  }
  const coordinates = new Map();
  for (const file of compare.files ?? []) {
    if (file.status !== 'added') {
      const path = file.previous_filename ?? file.filename;
      coordinates.set(`${review.baseSha}:${path}`, { path, ref: review.baseSha });
    }
    if (file.status !== 'removed') {
      coordinates.set(`${review.headSha}:${file.filename}`, {
        path: file.filename,
        ref: review.headSha,
      });
    }
  }
  for (const { path, ref } of coordinates.values()) {
    const routePath = `/${root}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await captureOptionalProviderRoute(() =>
      githubJson(review, `${routePath.slice(1)}?ref=${encodeURIComponent(ref)}`),
    );
    if (response != null) {
      routes.push({ path: routePath, query: { ref }, response });
    }
  }
  return sanitizeProviderTranscript(
    {
      kind: 'github-test-scenario-transcript-v1',
      routes,
    },
    review,
  );
};

const captureGitLabTranscript = async (review) => {
  const encodedProject = encodeURIComponent(review.repository);
  const apiRoot = `projects/${encodedProject}`;
  const comparePath = `/api/v4/${apiRoot}/repository/compare`;
  const compare = await gitlabJson(
    review,
    `${apiRoot}/repository/compare?from=${encodeURIComponent(review.baseSha)}&to=${encodeURIComponent(review.headSha)}&straight=true`,
  );
  const routes = [
    {
      path: comparePath,
      query: { from: review.baseSha, straight: 'true', to: review.headSha },
      response: compare,
    },
    {
      path: '/api/v4/user',
      response: await gitlabJson(review, 'user'),
    },
    {
      path: `/api/v4/${apiRoot}/merge_requests/${reviewNumber(review.url)}`,
      response: await gitlabJson(review, `${apiRoot}/merge_requests/${reviewNumber(review.url)}`),
    },
  ];
  for (const commit of compare.commits ?? []) {
    const sha = commit.id ?? commit.sha;
    if (typeof sha !== 'string') {
      continue;
    }
    const path = `/api/v4/${apiRoot}/repository/commits/${encodeURIComponent(sha)}/diff`;
    routes.push({
      path,
      query: { page: 1, per_page: 100 },
      response: await gitlabJson(review, path.replace(/^\/api\/v4\//, '')),
    });
  }
  const coordinates = new Map();
  for (const diff of compare.diffs ?? []) {
    if (!diff.new_file) {
      coordinates.set(`${review.baseSha}:${diff.old_path}`, {
        path: diff.old_path,
        ref: review.baseSha,
      });
    }
    if (!diff.deleted_file) {
      coordinates.set(`${review.headSha}:${diff.new_path}`, {
        path: diff.new_path,
        ref: review.headSha,
      });
    }
  }
  for (const { path, ref } of coordinates.values()) {
    const routePath = `/api/v4/${apiRoot}/repository/files/${encodeURIComponent(path)}`;
    const response = await captureOptionalProviderRoute(() =>
      gitlabJson(review, `${routePath.replace(/^\/api\/v4\//, '')}?ref=${encodeURIComponent(ref)}`),
    );
    if (response != null) {
      routes.push({ path: routePath, query: { ref }, response });
    }
  }
  return sanitizeProviderTranscript(
    {
      kind: 'gitlab-test-scenario-transcript-v1',
      routes,
    },
    review,
  );
};

const recordProviderMocks = async (values) => {
  const statePath = values.get('state');
  if (!statePath) {
    throw new Error('record-mocks requires --state PATH.');
  }
  const state = await readState(resolve(statePath));
  const providers = new Set(scenarioFilters(values, 'providers', 'github,gitlab'));
  const scenarios = new Set(
    scenarioFilters(values, 'scenarios', Object.keys(reviewScenarios).join(',')),
  );
  for (const review of state.reviews) {
    if (!providers.has(review.provider) || !scenarios.has(review.scenario)) {
      continue;
    }
    const transcript =
      review.provider === 'github'
        ? await captureGitHubTranscript(review)
        : await captureGitLabTranscript(review);
    const directory = join('evals', 'fixtures', 'test-scenario-provider-mocks', review.scenario);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${review.provider}.json`),
      `${JSON.stringify(transcript, null, 2)}\n`,
    );
    process.stdout.write(`Recorded provider mock: ${review.provider}/${review.scenario}\n`);
  }
};

const revisionPosition = (review, revision) => ({
  range: {
    base: {
      kind: 'commit',
      label: { kind: 'commit', text: 'base' },
      sha: review.baseSha,
    },
    head: {
      kind: 'commit',
      label: { kind: 'commit', text: 'target' },
      sha: revision,
    },
  },
});

const reviewSource = (review) => ({
  headSha: review.headSha,
  provider: review.provider,
  type: 'pull-request',
  url: review.url,
});

const githubPullComments = async (review) => {
  const [owner, repository] = review.repository.split('/', 2);
  return JSON.parse(
    await command(
      review.worktree,
      'gh',
      [
        'api',
        '--paginate',
        `repos/${owner}/${repository}/pulls/${reviewNumber(review.url)}/comments`,
      ],
      { capture: true },
    ),
  );
};

const gitlabDiscussions = async (review) => {
  const host = new URL(review.url).host;
  return JSON.parse(
    await command(
      review.worktree,
      'glab',
      [
        'api',
        '--hostname',
        host,
        `projects/${encodeURIComponent(review.repository)}/merge_requests/${reviewNumber(review.url)}/discussions?per_page=100`,
      ],
      { capture: true },
    ),
  );
};

const submissionBody = (review, action, suffix = '') =>
  `[Codiff scenario ${review.scenario}/${review.provider}/${action.id}${suffix}]`;

const resolveActionAnchor = (review, target) =>
  resolveSubmissionAnchor({
    ...target,
    runGit: (args) => runGit(review.worktree, args),
  });

const reviewComment = (review, anchor, body, localDraftId) => ({
  body,
  filePath: anchor.path,
  lineNumber: anchor.line,
  localDraftId,
  position: revisionPosition(review, anchor.revision),
  side: 'additions',
});

const expectTargetResolutionFailure = async (operation) => {
  try {
    await operation();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'target-resolution-failed') {
      return;
    }
    throw error;
  }
  throw new Error('Expected target-resolution-failed, but submission succeeded.');
};

const assertGitHubArtifact = async (review, body) => {
  const comments = await githubPullComments(review);
  if (!comments.some((comment) => comment.body === body)) {
    throw new Error(`GitHub did not expose expected review comment ${body}.`);
  }
};

const assertGitLabArtifact = async (review, body) => {
  const discussions = await gitlabDiscussions(review);
  if (
    !discussions.some(
      (discussion) =>
        Array.isArray(discussion.notes) && discussion.notes.some((note) => note.body === body),
    )
  ) {
    throw new Error(`GitLab did not expose expected discussion note ${body}.`);
  }
};

const runGitHubSubmissionTests = async (review) => {
  const source = reviewSource(review);
  const plan = await getSubmissionPlan({
    provider: 'github',
    revisions: review.revisions,
    scenarioId: review.scenario,
  });
  for (const action of plan) {
    try {
      if (action.type === 'inline-comment') {
        const anchor = await resolveActionAnchor(review, action.target);
        const body = submissionBody(review, action);
        await submitPullRequestComment(review.worktree, {
          comment: reviewComment(review, anchor, body, action.id),
          source,
        });
        await assertGitHubArtifact(review, body);
        continue;
      }
      if (action.type === 'review') {
        const comments = await Promise.all(
          action.targets.map(async (target, index) => {
            const anchor = await resolveActionAnchor(review, target);
            const body = submissionBody(review, action, `#${index + 1}`);
            return reviewComment(review, anchor, body, `${action.id}-${index + 1}`);
          }),
        );
        const result = await submitPullRequestReview(review.worktree, {
          body: submissionBody(review, action),
          comments,
          event: action.event,
          source,
        });
        if (result.status !== 'submitted' || result.submittedDraftIds.length !== comments.length) {
          throw new Error(result.reason ?? 'GitHub did not submit every review draft.');
        }
        for (const comment of comments) {
          await assertGitHubArtifact(review, comment.body);
        }
        continue;
      }
      if (action.type === 'invalid-target') {
        const anchor = await resolveActionAnchor(review, action.target);
        const body = submissionBody(review, action);
        const before = (await githubPullComments(review)).length;
        await expectTargetResolutionFailure(() =>
          submitPullRequestComment(review.worktree, {
            comment: reviewComment(review, anchor, body, action.id),
            source,
          }),
        );
        const after = (await githubPullComments(review)).length;
        if (after !== before) {
          throw new Error('GitHub created an artifact for a rejected review target.');
        }
        continue;
      }
      throw new Error(`Unsupported GitHub submission action: ${action.type}.`);
    } catch (error) {
      throw new Error(
        `GitHub review submission ${review.scenario}/${action.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
};

const runGitLabSubmissionTests = async (review) => {
  const source = reviewSource(review);
  const plan = await getSubmissionPlan({
    provider: 'gitlab',
    revisions: review.revisions,
    scenarioId: review.scenario,
  });
  for (const action of plan) {
    try {
      if (action.type === 'inline-comment') {
        const anchor = await resolveActionAnchor(review, action.target);
        const body = submissionBody(review, action);
        await submitMergeRequestComment(review.worktree, {
          comment: reviewComment(review, anchor, body, action.id),
          source,
        });
        await assertGitLabArtifact(review, body);
        continue;
      }
      if (action.type === 'review') {
        const comments = await Promise.all(
          action.targets.map(async (target, index) => {
            const anchor = await resolveActionAnchor(review, target);
            const body = submissionBody(review, action, `#${index + 1}`);
            return reviewComment(review, anchor, body, `${action.id}-${index + 1}`);
          }),
        );
        const result = await submitMergeRequestReview(review.worktree, {
          body: submissionBody(review, action),
          comments,
          event: action.event,
          source,
        });
        if (result.status !== 'submitted' || result.submittedDraftIds.length !== comments.length) {
          throw new Error(result.reason ?? 'GitLab did not submit every review draft.');
        }
        for (const comment of comments) {
          await assertGitLabArtifact(review, comment.body);
        }
        continue;
      }
      if (action.type === 'invalid-target') {
        const anchor = await resolveActionAnchor(review, action.target);
        const body = submissionBody(review, action);
        const before = (await gitlabDiscussions(review)).length;
        await expectTargetResolutionFailure(() =>
          submitMergeRequestComment(review.worktree, {
            comment: reviewComment(review, anchor, body, action.id),
            source,
          }),
        );
        const after = (await gitlabDiscussions(review)).length;
        if (after !== before) {
          throw new Error('GitLab created an artifact for a rejected review target.');
        }
        continue;
      }
      throw new Error(`Unsupported GitLab submission action: ${action.type}.`);
    } catch (error) {
      throw new Error(
        `GitLab review submission ${review.scenario}/${action.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
};

const runSubmissionTests = async (values) => {
  const statePath = values.get('state');
  if (!statePath) {
    throw new Error('run-tests requires --state PATH.');
  }
  const state = await readState(resolve(statePath));
  const providers = new Set(scenarioFilters(values, 'providers', 'github,gitlab'));
  const scenarios = new Set(
    scenarioFilters(values, 'scenarios', Object.keys(reviewScenarios).join(',')),
  );
  const reviews = state.reviews.filter(
    (review) => providers.has(review.provider) && scenarios.has(review.scenario),
  );
  if (reviews.length === 0) {
    throw new Error('No matching scenario reviews exist in the supplied state file.');
  }
  for (const review of reviews) {
    if (review.provider === 'github') {
      await runGitHubSubmissionTests(review);
    } else {
      await runGitLabSubmissionTests(review);
    }
    process.stdout.write(`Review submission tests passed: ${review.provider}/${review.scenario}\n`);
  }
};

const destroy = async (values) => {
  const statePath = values.get('state');
  if (!statePath || values.get('yes') !== 'true') {
    throw new Error('destroy requires --state PATH --yes.');
  }
  const state = await readState(resolve(statePath));
  for (const review of state.reviews) {
    if (review.provider === 'github') {
      await closeGitHubReviews(review.repository);
    } else {
      await closeGitLabReviews(review);
    }
  }
  await rm(state.root, { force: true, recursive: true });
  await rm(resolve(statePath), { force: true });
  process.stdout.write(`Closed smoke reviews and removed ${resolve(statePath)}\n`);
};

const main = async () => {
  const { positional, values } = parseArguments(process.argv.slice(2));
  const action = positional[0];
  if (!action || action === 'help' || action === '--help') {
    usage();
    return;
  }
  if (action === 'create-scenarios' || action === 'create') {
    await createScenarios(values);
    return;
  }
  if (action === 'record-mocks') {
    await recordProviderMocks(values);
    return;
  }
  if (action === 'run-tests') {
    await runSubmissionTests(values);
    return;
  }
  const statePath = values.get('state');
  if (!statePath) {
    throw new Error(`${action} requires --state PATH.`);
  }
  const state = await readState(resolve(statePath));
  if (action === 'status') {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    printCodiffCommands(state);
    return;
  }
  if (action === 'open') {
    const provider = values.get('provider');
    const scenario = values.get('scenario');
    const review = state.reviews.find(
      (candidate) =>
        candidate.provider === provider && (!scenario || candidate.scenario === scenario),
    );
    if (!review) {
      throw new Error(
        `No ${provider ?? 'requested'} ${scenario ? `${scenario} ` : ''}review exists in this state.`,
      );
    }
    await command(process.cwd(), 'pnpm', [
      'exec',
      'codiff',
      ...(values.get('walkthrough') === 'true' ? ['--walkthrough'] : []),
      review.url,
      review.worktree,
    ]);
    return;
  }
  if (action === 'destroy') {
    await destroy(values);
    return;
  }
  throw new Error(`Unknown action: ${action}`);
};

try {
  await main();
} catch (error) {
  process.stderr.write(
    `test-scenarios: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
