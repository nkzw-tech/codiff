import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, gte, sql } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import schema from './schema.ts';

export type Database = DrizzleD1Database<typeof schema>;
export type D1Binding = D1Database;
export type DatabaseBatchStatement = Parameters<Database['batch']>[0][number];

const databaseBatchSize = 500;
const bookmarkCookieName = 'codiff-d1-bookmark';
const bookmarkCookiePattern = new RegExp(`(?:^|;\\s*)${bookmarkCookieName}=([\\w-]+)(?:;|$)`);
const store = new AsyncLocalStorage<Database>();

export const createDb = (binding: D1Binding): Database => drizzle(binding, { schema });

// Drizzle only calls prepare() and batch(), which D1 sessions implement.
const isDrizzleD1Client = (client: D1DatabaseSession | D1Binding): client is D1Binding =>
  typeof client.prepare === 'function' && typeof client.batch === 'function';

const createSessionDb = (session: D1DatabaseSession): Database => {
  if (!isDrizzleD1Client(session)) {
    throw new Error('D1 session does not support prepare() and batch().');
  }
  return drizzle(session, { schema });
};

export const createPrimaryDb = (binding: D1Binding): Database =>
  createSessionDb(binding.withSession('first-primary'));

// Carry the browser's latest D1 state across requests so replica reads never go backwards.
export const createRequestDb = (binding: D1Binding, request: Request) => {
  const bookmark = request.headers.get('cookie')?.match(bookmarkCookiePattern)?.[1];
  const session = binding.withSession(bookmark ?? 'first-unconstrained');
  return {
    db: createSessionDb(session),
    withBookmark: (response: Response) => {
      const latest = session.getBookmark();
      if (!latest || latest === bookmark) {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.append(
        'set-cookie',
        `${bookmarkCookieName}=${latest}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
      );
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    },
  };
};

export const withDatabase = <Value>(binding: D1Binding | Database, callback: () => Value): Value =>
  store.run('select' in binding ? binding : createDb(binding), callback);

export const runDatabaseBatches = async (
  database: Database,
  statements: ReadonlyArray<DatabaseBatchStatement>,
) => {
  for (let index = 0; index < statements.length; index += databaseBatchSize) {
    const chunk = statements.slice(index, index + databaseBatchSize);
    const first = chunk[0];
    if (first) {
      await database.batch([first, ...chunk.slice(1)]);
    }
  }
};

const getDb = (): Database => {
  const database = store.getStore();
  if (!database) {
    throw new Error('Codiff sharing database is unavailable.');
  }
  return database;
};

export const db = new Proxy({} as Database, {
  get(_target, property, receiver) {
    // oxlint-disable-next-line quality/no-reflect-get -- Forward getter calls with their original receiver.
    return Reflect.get(getDb(), property, receiver);
  },
});

export { and, eq, gte, sql };
