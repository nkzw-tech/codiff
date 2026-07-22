import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { getRepositoryWindowTitle } = require('../window-title.cjs') as {
  getRepositoryWindowTitle: (state: {
    root: string;
    source:
      | { type: 'working-tree' }
      | { ref: string; type: 'branch-working-tree' }
      | { ref: string; type: 'commit' }
      | { number?: number; type: 'pull-request'; url: string }
      | { base: string; head: string; symmetric: boolean; type: 'range' };
  }) => string;
};

const root = '/Users/reviewer/Documents/GitHub/MyCoolRepo';

test('titles windows with the repository and selected source', () => {
  expect(getRepositoryWindowTitle({ root, source: { type: 'working-tree' } })).toBe(
    'Codiff – MyCoolRepo',
  );
  expect(
    getRepositoryWindowTitle({
      root,
      source: {
        number: 1337,
        type: 'pull-request',
        url: 'https://github.com/framer/MyCoolRepo/pull/1337',
      },
    }),
  ).toBe('Codiff – MyCoolRepo/1337');
  expect(
    getRepositoryWindowTitle({
      root,
      source: { type: 'pull-request', url: 'https://github.com/framer/MyCoolRepo/pull/1338' },
    }),
  ).toBe('Codiff – MyCoolRepo/1338');
  expect(
    getRepositoryWindowTitle({
      root,
      source: { ref: 'feature/new-title', type: 'branch-working-tree' },
    }),
  ).toBe('Codiff – MyCoolRepo/feature/new-title');
  expect(getRepositoryWindowTitle({ root, source: { ref: 'a1b2c3d4', type: 'commit' } })).toBe(
    'Codiff – MyCoolRepo/a1b2c3d',
  );
  expect(
    getRepositoryWindowTitle({
      root,
      source: { base: 'main', head: 'feature', symmetric: true, type: 'range' },
    }),
  ).toBe('Codiff – MyCoolRepo/main...feature');
});
