/**
 * Host-injected GitHub transport.
 *
 * The host authenticates and executes HTTP (gh api / fetch). This package owns
 * endpoint construction, pagination policy, and response parsing.
 */
export type GitHubTransport = {
  graphql?<T>(request: {
    /** Maximum response bytes the host may retain. */
    maxBytes?: number;
    query: string;
    signal?: AbortSignal;
    variables: Readonly<Record<string, boolean | number | string | null>>;
  }): Promise<T>;
  request<T>(request: {
    accept?: string;
    body?: unknown;
    /** Maximum response bytes the host may retain. */
    maxBytes?: number;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    /** When true, hosts should follow pagination and return a combined array. */
    paginate?: boolean;
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
    signal?: AbortSignal;
  }): Promise<T>;
  /** Optional binary response reader for images and other raw assets. */
  requestBuffer?(request: {
    accept?: string;
    /** Maximum raw response bytes the host may retain. */
    maxBytes?: number;
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
  /** Optional raw text reader. */
  requestText?(request: {
    accept?: string;
    body?: unknown;
    /** Maximum response bytes the host may retain. */
    maxBytes?: number;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    paginate?: boolean;
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
    signal?: AbortSignal;
  }): Promise<string>;
};

export type FakeGitHubTransportRoute = {
  body?: unknown;
  bytes?:
    | Uint8Array
    | ((request: {
        method: string;
        path: string;
        query?: Readonly<Record<string, boolean | number | string>>;
      }) => Uint8Array | Promise<Uint8Array>);
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  query?: Readonly<Record<string, boolean | number | string>>;
  response:
    | unknown
    | ((request: {
        method: string;
        path: string;
        query?: Readonly<Record<string, boolean | number | string>>;
      }) => unknown | Promise<unknown>);
};

const queryKey = (query?: Readonly<Record<string, boolean | number | string>>) =>
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

/**
 * Deterministic transport for package tests.
 */
export const createFakeGitHubTransport = (
  routes: ReadonlyArray<FakeGitHubTransportRoute>,
): GitHubTransport & {
  calls: Array<{
    maxBytes?: number;
    method: string;
    path: string;
    query?: Record<string, boolean | number | string>;
  }>;
} => {
  const calls: Array<{
    maxBytes?: number;
    method: string;
    path: string;
    query?: Record<string, boolean | number | string>;
  }> = [];

  const matchRoute = (
    method: string,
    path: string,
    query?: Readonly<Record<string, boolean | number | string>>,
  ) => {
    const key = queryKey(query);
    return (
      routes.find(
        (route) =>
          route.path === path &&
          (route.method ?? 'GET') === method &&
          queryKey(route.query) === key,
      ) ??
      routes.find(
        (route) => route.path === path && (route.method ?? 'GET') === method && route.query == null,
      )
    );
  };

  return {
    calls,
    async request(request) {
      request.signal?.throwIfAborted();
      const method = request.method ?? 'GET';
      calls.push({
        ...(request.maxBytes == null ? {} : { maxBytes: request.maxBytes }),
        method,
        path: request.path,
        ...(request.query ? { query: { ...request.query } } : {}),
      });
      const route = matchRoute(method, request.path, request.query);
      if (!route) {
        throw new Error(`No fake GitHub route for ${method} ${request.path}`);
      }
      const response = await withAbort(
        typeof route.response === 'function'
          ? Promise.resolve(
              route.response({
                method,
                path: request.path,
                ...(request.query ? { query: request.query } : {}),
              }),
            )
          : Promise.resolve(route.response),
        request.signal,
      );
      return response as never;
    },
    async requestBuffer(request) {
      request.signal?.throwIfAborted();
      calls.push({
        ...(request.maxBytes == null ? {} : { maxBytes: request.maxBytes }),
        method: 'GET',
        path: request.path,
        ...(request.query ? { query: { ...request.query } } : {}),
      });
      const route = matchRoute('GET', request.path, request.query);
      if (!route || route.bytes == null) {
        throw new Error(`No fake GitHub byte route for GET ${request.path}`);
      }
      const bytes = await withAbort(
        Promise.resolve(
          typeof route.bytes === 'function'
            ? route.bytes({ method: 'GET', path: request.path, query: request.query })
            : route.bytes,
        ),
        request.signal,
      );
      if (request.maxBytes != null && bytes.byteLength > request.maxBytes) {
        const error = new Error(
          `GitHub response exceeded the ${request.maxBytes}-byte safety limit.`,
        );
        error.name = 'ProviderOutputLimitError';
        throw error;
      }
      return bytes;
    },
  };
};
