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
