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
