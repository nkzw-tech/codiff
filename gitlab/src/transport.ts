/**
 * Host-injected GitLab transport.
 *
 * The host authenticates and executes HTTP. This package owns endpoint
 * construction, pagination policy, and response parsing.
 */
export type GitLabTransport = {
  request<T>(request: {
    body?: unknown;
    /** Maximum response bytes the host may retain. */
    maxBytes?: number;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
    signal?: AbortSignal;
  }): Promise<T>;
  /** Optional raw byte reader for immutable repository blobs. */
  requestBuffer?(request: {
    /** Maximum raw response bytes the host may retain. */
    maxBytes?: number;
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
  /**
   * Optional paginated reader. When omitted, {@link request} is called with
   * `page` / `per_page` until a short page is returned.
   */
  requestPages?(request: {
    /** Maximum combined response bytes the host may retain. */
    maxBytes?: number;
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
    signal?: AbortSignal;
  }): Promise<Array<unknown>>;
  /** Optional raw text reader for repository file blobs. */
  requestText?(request: {
    /** Maximum response bytes the host may retain. */
    maxBytes?: number;
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
    signal?: AbortSignal;
  }): Promise<string>;
};

export type FakeGitLabTransportRoute = {
  body?: unknown;
  bytes?:
    | Uint8Array
    | ((request: {
        method: string;
        path: string;
        query?: Readonly<Record<string, boolean | number | string>>;
      }) => Uint8Array | Promise<Uint8Array>);
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Readonly<Record<string, boolean | number | string>>;
  response:
    | unknown
    | ((request: {
        method: string;
        path: string;
        query?: Readonly<Record<string, boolean | number | string>>;
      }) => unknown | Promise<unknown>);
  text?:
    | string
    | ((request: {
        method: string;
        path: string;
        query?: Readonly<Record<string, boolean | number | string>>;
      }) => string | Promise<string>);
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
export const createFakeGitLabTransport = (
  routes: ReadonlyArray<FakeGitLabTransportRoute>,
): GitLabTransport & {
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
        throw new Error(
          `No fake GitLab route for ${method} ${request.path}?${queryKey(request.query)}`,
        );
      }
      const response = await withAbort(
        typeof route.response === 'function'
          ? Promise.resolve(route.response({ method, path: request.path, query: request.query }))
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
        throw new Error(`No fake GitLab byte route for GET ${request.path}`);
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
          `GitLab response exceeded the ${request.maxBytes}-byte safety limit.`,
        );
        error.name = 'ProviderOutputLimitError';
        throw error;
      }
      return bytes;
    },
    async requestPages(request) {
      // Collect all pages if fake routes include page query variants; else one shot.
      const values: Array<unknown> = [];
      let page = 1;
      while (page < 50) {
        request.signal?.throwIfAborted();
        const pageQuery = { ...(request.query ?? {}), page, per_page: 100 };
        const route =
          matchRoute('GET', request.path, pageQuery) ??
          (page === 1 ? matchRoute('GET', request.path, request.query) : undefined);
        if (!route) {
          break;
        }
        calls.push({
          ...(request.maxBytes == null ? {} : { maxBytes: request.maxBytes }),
          method: 'GET',
          path: request.path,
          query: pageQuery,
        });
        const response = await withAbort(
          typeof route.response === 'function'
            ? Promise.resolve(
                route.response({ method: 'GET', path: request.path, query: pageQuery }),
              )
            : Promise.resolve(route.response),
          request.signal,
        );
        const pageValues = Array.isArray(response) ? response : [];
        values.push(...pageValues);
        if (pageValues.length < 100) {
          break;
        }
        page += 1;
      }
      return values;
    },
    async requestText(request) {
      request.signal?.throwIfAborted();
      calls.push({
        ...(request.maxBytes == null ? {} : { maxBytes: request.maxBytes }),
        method: 'GET',
        path: request.path,
        ...(request.query ? { query: { ...request.query } } : {}),
      });
      const route = matchRoute('GET', request.path, request.query);
      if (!route || route.text == null) {
        throw new Error(`No fake GitLab text route for GET ${request.path}`);
      }
      return withAbort(
        Promise.resolve(
          typeof route.text === 'function'
            ? route.text({ method: 'GET', path: request.path, query: request.query })
            : route.text,
        ),
        request.signal,
      );
    },
  };
};
