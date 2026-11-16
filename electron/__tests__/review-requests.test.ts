import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import type { ReviewProject, ReviewRequestListQuery, ReviewRequestPage } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { listReviewRequests, readReviewProjects } = require('../git-state/review-requests.cjs') as {
  listReviewRequests: (root: string, query: ReviewRequestListQuery) => Promise<ReviewRequestPage>;
  readReviewProjects: (root: string) => Promise<ReadonlyArray<ReviewProject>>;
};

test('lists and paginates reviews from the selected self-hosted GitLab project', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-requests-');
  const git = (...args: Array<string>) => execFileSync('git', args, { cwd: directory.path });
  git('init', '-q');
  git('remote', 'add', 'upstream', 'git@github.com:org/project.git');
  git('remote', 'add', 'origin', 'git@gitlab.example.com:org/team/project.git');
  git('remote', 'add', 'mirror', 'https://gitlab.example.com/org/team/project.git');
  const cli = join(directory.path, 'glab');
  await writeFile(
    cli,
    `#!${process.execPath}
const [api, hostname, host, endpoint] = process.argv.slice(2);
const [path, query] = endpoint.split('?');
const params = new URLSearchParams(query);
if (api !== 'api' || hostname !== '--hostname' || host !== 'gitlab.example.com' ||
    path !== 'projects/org%2Fteam%2Fproject/merge_requests' || params.get('scope') !== 'all') {
  process.exit(1);
}
const page = Number(params.get('page'));
const fixture = (iid, state = 'opened') => ({
  author: { username: 'reviewer' },
  draft: iid === 1,
  iid,
  state,
  title: 'Review ' + iid,
  updated_at: '2025-05-21T10:00:00Z',
  web_url: 'https://gitlab.example.com/org/team/project/-/merge_requests/' + iid,
});
let results;
if (params.get('iids[]') === '45' && params.get('state') === 'merged') {
  results = [fixture(45, 'merged')];
} else if (params.get('state') === 'opened' && params.get('order_by') === 'updated_at' &&
           params.get('sort') === 'desc' && params.get('search') === 'Review' &&
           params.get('in') === 'title') {
  results = page === 1 ? Array.from({ length: Number(params.get('per_page')) }, (_, i) => fixture(i + 1)) : [fixture(36)];
} else {
  process.exit(1);
}
process.stdout.write(JSON.stringify(results));
`,
    { mode: 0o755 },
  );
  await using _environment = createTemporaryEnvironment({ CODIFF_GLAB_PATH: cli });

  const projects = await readReviewProjects(directory.path);
  expect(projects.map(({ provider, remote }) => [provider, remote])).toEqual([
    ['gitlab', 'origin'],
    ['github', 'upstream'],
  ]);
  const query = {
    filter: 'open',
    projectId: projects[0].id,
    search: 'Review',
    sort: 'updated',
  } as const;
  const first = await listReviewRequests(directory.path, query);
  expect(first.entries[0]).toMatchObject({
    author: 'reviewer',
    draft: true,
    source: { number: 1, provider: 'gitlab' },
    state: 'open',
  });
  expect(first.nextCursor).toBe('2');
  const second = await listReviewRequests(directory.path, { ...query, cursor: first.nextCursor });
  expect(second.entries.map(({ source }) => source.number)).toEqual([36]);
  expect(second.nextCursor).toBeUndefined();
  expect(
    (await listReviewRequests(directory.path, { ...query, filter: 'merged', search: '!45' }))
      .entries,
  ).toMatchObject([{ draft: false, source: { number: 45 }, state: 'merged' }]);
});
