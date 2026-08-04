import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const fixturesRoot = join('evals', 'fixtures', 'test-scenario-provider-mocks');

const substituteTranscript = (value, { repository, revisions }) => {
  const [owner, repositoryName] = repository.split('/', 2);
  if (typeof value === 'string') {
    return value
      .replaceAll('{{repository}}', repository)
      .replaceAll('{{encodedRepository}}', encodeURIComponent(repository))
      .replaceAll('{{review-url}}', `https://provider.example.test/${repository}/review/1`)
      .replaceAll('{{provider-owner}}', owner)
      .replaceAll('{{scenario-repository}}', repositoryName)
      .replaceAll(/\{\{revision:([^}]+)\}\}/g, (_, name) => revisions[name] ?? '')
      .replaceAll(
        /\{\{shortRevision:([^}]+)\}\}/g,
        (_, name) => revisions[name]?.slice(0, 8) ?? '',
      );
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteTranscript(item, { repository, revisions }));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substituteTranscript(item, { repository, revisions }),
      ]),
    );
  }
  return value;
};

const queryKey = (query) =>
  query
    ? Object.entries(query)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('&')
    : '';

const createTranscriptTransport = (routes) => {
  const calls = [];
  const matchRoute = (method, path, query) =>
    routes.find(
      (route) =>
        route.path === path &&
        (route.method ?? 'GET') === method &&
        queryKey(route.query) === queryKey(query),
    );
  const record = (request, method = 'GET') => {
    request.signal?.throwIfAborted();
    calls.push({
      ...(request.maxBytes == null ? {} : { maxBytes: request.maxBytes }),
      method,
      path: request.path,
      ...(request.query ? { query: { ...request.query } } : {}),
    });
    const route = matchRoute(method, request.path, request.query);
    if (!route) {
      throw new Error(
        `No provider transcript route for ${method} ${request.path}?${queryKey(request.query)}`,
      );
    }
    return route;
  };
  return {
    calls,
    async request(request) {
      const method = request.method ?? 'GET';
      const route = record(request, method);
      return globalThis.structuredClone(route.response);
    },
    async requestBuffer(request) {
      const route = record(request);
      if (typeof route.bytes !== 'string') {
        throw new Error(`Provider transcript route ${request.path} has no byte response.`);
      }
      const bytes = new Uint8Array(Buffer.from(route.bytes, 'base64'));
      if (request.maxBytes != null && bytes.byteLength > request.maxBytes) {
        throw new Error(`Provider transcript response exceeds ${request.maxBytes} bytes.`);
      }
      return bytes;
    },
    async requestText(request) {
      const route = record(request);
      if (typeof route.text !== 'string') {
        throw new Error(`Provider transcript route ${request.path} has no text response.`);
      }
      if (request.maxBytes != null && Buffer.byteLength(route.text) > request.maxBytes) {
        throw new Error(`Provider transcript response exceeds ${request.maxBytes} bytes.`);
      }
      return route.text;
    },
  };
};

const loadScenarioMock = async ({ fixtureRoot, provider, repository, revisions, scenarioId }) => {
  const fixturePath = join(fixtureRoot, scenarioId, `${provider}.json`);
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const transcript = substituteTranscript(fixture, { repository, revisions });
  if (transcript.kind !== `${provider}-test-scenario-transcript-v1`) {
    throw new Error(`Unexpected ${provider} provider transcript kind.`);
  }
  if (!Array.isArray(transcript.routes)) {
    throw new Error(`The ${provider} provider transcript has no routes.`);
  }
  return {
    transcript,
    transport: createTranscriptTransport(transcript.routes),
  };
};

export const loadGitHubScenarioMock = async ({
  fixtureRoot = fixturesRoot,
  owner,
  repository = undefined,
  revisions,
  scenarioId,
}) =>
  loadScenarioMock({
    fixtureRoot,
    provider: 'github',
    repository: `${owner}/${repository ?? scenarioId}`,
    revisions,
    scenarioId,
  });

export const loadGitLabScenarioMock = async ({
  fixtureRoot = fixturesRoot,
  projectPath,
  revisions,
  scenarioId,
}) =>
  loadScenarioMock({
    fixtureRoot,
    provider: 'gitlab',
    repository: projectPath,
    revisions,
    scenarioId,
  });
