import type { GitHubTransport } from '../github/src/transport.ts';
import type { GitLabTransport } from '../gitlab/src/transport.ts';

type Query = Readonly<Record<string, boolean | number | string>>;
type FakeTransportRequest = { method: string; path: string; query?: Query };
type FakeTransportRoute = {
  bytes?: Uint8Array | ((request: FakeTransportRequest) => Promise<Uint8Array> | Uint8Array);
  method?: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
  path: string;
  query?: Query;
  response: unknown | ((request: FakeTransportRequest) => Promise<unknown> | unknown);
  text?: string | ((request: FakeTransportRequest) => Promise<string> | string);
};
type FakeTransportCall = {
  maxBytes?: number;
  method: string;
  path: string;
  query?: Record<string, boolean | number | string>;
};
type FakeTransport = GitHubTransport &
  GitLabTransport & {
    calls: Array<FakeTransportCall>;
  };

const queryKey = (query?: Query) =>
  query
    ? Object.entries(query)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('&')
    : '';

const withAbort = async <Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> => {
  signal?.throwIfAborted();
  if (!signal) {
    return promise;
  }
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};

const createFakeTransport = (
  provider: 'GitHub' | 'GitLab',
  routes: ReadonlyArray<FakeTransportRoute>,
): FakeTransport => {
  const calls: Array<FakeTransportCall> = [];
  const match = (method: string, path: string, query?: Query) =>
    routes.find(
      (route) =>
        route.path === path &&
        (route.method ?? 'GET') === method &&
        queryKey(route.query) === queryKey(query),
    ) ??
    routes.find(
      (route) => route.path === path && (route.method ?? 'GET') === method && route.query == null,
    );
  const record = (request: { maxBytes?: number; method?: string; path: string; query?: Query }) => {
    const method = request.method ?? 'GET';
    calls.push({
      ...(request.maxBytes == null ? {} : { maxBytes: request.maxBytes }),
      method,
      path: request.path,
      ...(request.query ? { query: { ...request.query } } : {}),
    });
    return method;
  };
  const value = async <Value>(
    routeValue: Value | ((request: FakeTransportRequest) => Promise<Value> | Value),
    request: FakeTransportRequest,
    signal?: AbortSignal,
  ) =>
    withAbort(
      Promise.resolve(
        typeof routeValue === 'function'
          ? (routeValue as (request: FakeTransportRequest) => Promise<Value> | Value)(request)
          : routeValue,
      ),
      signal,
    );

  return {
    calls,
    async request(request) {
      request.signal?.throwIfAborted();
      const method = record(request);
      const route = match(method, request.path, request.query);
      if (!route) {
        throw new Error(`No fake ${provider} route for ${method} ${request.path}`);
      }
      return value(
        route.response as never,
        { method, path: request.path, query: request.query },
        request.signal,
      );
    },
    async requestBuffer(request) {
      request.signal?.throwIfAborted();
      record(request);
      const route = match('GET', request.path, request.query);
      if (!route?.bytes) {
        throw new Error(`No fake ${provider} byte route for GET ${request.path}`);
      }
      const bytes = await value(
        route.bytes,
        { method: 'GET', path: request.path, query: request.query },
        request.signal,
      );
      if (request.maxBytes != null && bytes.byteLength > request.maxBytes) {
        const error = new Error(
          `${provider} response exceeded the ${request.maxBytes}-byte safety limit.`,
        );
        error.name = 'ProviderOutputLimitError';
        throw error;
      }
      return bytes;
    },
    async requestPages(request) {
      const values: Array<unknown> = [];
      for (let page = 1; page < 50; page += 1) {
        request.signal?.throwIfAborted();
        const query = { ...(request.query ?? {}), page, per_page: 100 };
        const route =
          match('GET', request.path, query) ??
          (page === 1 ? match('GET', request.path, request.query) : undefined);
        if (!route) {
          break;
        }
        record({ ...request, query });
        const response = await value(
          route.response as never,
          { method: 'GET', path: request.path, query },
          request.signal,
        );
        const pageValues = Array.isArray(response) ? response : [];
        values.push(...pageValues);
        if (pageValues.length < 100) {
          break;
        }
      }
      return values;
    },
    async requestText(request) {
      request.signal?.throwIfAborted();
      record(request);
      const route = match('GET', request.path, request.query);
      if (route?.text == null) {
        throw new Error(`No fake ${provider} text route for GET ${request.path}`);
      }
      return value(
        route.text,
        { method: 'GET', path: request.path, query: request.query },
        request.signal,
      );
    },
  };
};

export const createFakeGitHubTransport = (routes: ReadonlyArray<FakeTransportRoute>) =>
  createFakeTransport('GitHub', routes);

export const createFakeGitLabTransport = (routes: ReadonlyArray<FakeTransportRoute>) =>
  createFakeTransport('GitLab', routes);
