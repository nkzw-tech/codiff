import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import {
  bindDisposableHttpServer,
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from './helpers/resources.ts';

const require = createRequire(import.meta.url);
const { readRepositoryState } = require('../../electron/git-state.cjs') as {
  readRepositoryState: (
    path: string,
    source?: { ref: string; type: 'commit' },
  ) => Promise<{
    files: ReadonlyArray<{
      path: string;
      sections: ReadonlyArray<{ id: string; patch: string }>;
    }>;
  }>;
};
const { getSectionWalkthroughHunks } = require('../lib/narrative-walkthrough-diff.cjs') as {
  getSectionWalkthroughHunks: (
    file: { path: string },
    section: { id: string; patch: string },
  ) => ReadonlyArray<{ id: string }>;
};
const execFileAsync = promisify(execFile);

type UploadedBody = {
  snapshot: {
    kind: string;
    repository: {
      root: string;
      source: { ref?: string; type: string };
      title?: string;
    };
    version: number;
    walkthrough: {
      agent: string;
      title: string;
      version: number;
    };
  };
  uploader: {
    email: string;
    name: string;
  };
};

const git = (repositoryPath: string, args: ReadonlyArray<string>) =>
  execFileAsync('git', ['-c', 'commit.gpgsign=false', '-C', repositoryPath, ...args], {
    encoding: 'utf8',
  });

test('headless share uploads the canonical snapshot and prints its URL', async () => {
  await using directory = await createTemporaryDirectory('codiff-headless-share-');
  const repositoryPath = join(directory.path, 'repo');
  const walkthroughFile = join(directory.path, 'walkthrough.json');
  let uploadedBody: UploadedBody | null = null;
  let uploadHeaders: Record<string, string | Array<string> | undefined> = {};

  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.method === 'POST' && request.url === '/api/upload-intents') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          claimUrl: `${origin}/connect/CODE?secret=secret`,
          code: 'CODE',
          pollUrl: `${origin}/api/upload-intents/CODE?secret=secret`,
          secret: 'secret',
          status: 'claimed',
        }),
      );
      return;
    }

    if (request.method === 'POST' && request.url === '/api/uploads') {
      const chunks: Array<Buffer> = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        uploadedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as UploadedBody;
        uploadHeaders = request.headers;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            status: 'uploaded',
            url: `${origin}/w/shared-walkthrough`,
          }),
        );
      });
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  await mkdir(repositoryPath);
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'author@cloudflare.com']);
  await git(repositoryPath, ['config', 'user.name', 'Cloudflare Author']);
  await writeFile(join(repositoryPath, 'example.txt'), 'before\n');
  await git(repositoryPath, ['add', 'example.txt']);
  await git(repositoryPath, ['commit', '-m', 'Initial commit']);
  await writeFile(join(repositoryPath, 'example.txt'), 'after\n');

  const state = await readRepositoryState(repositoryPath);
  const file = state.files[0];
  const hunk = getSectionWalkthroughHunks(file, file.sections[0])[0];
  await writeFile(
    walkthroughFile,
    JSON.stringify({
      chapters: [
        {
          blurb: 'Review the behavior change.',
          icon: 'wrench',
          id: 'change',
          stops: [
            {
              hunkIds: [hunk.id],
              id: 's1',
              importance: 'normal',
              prose: 'The file now contains the updated value.',
            },
          ],
          title: 'Change',
        },
      ],
      focus: 'Update the example value.',
      kind: 'narrative',
      title: 'Example update',
      version: 4,
    }),
  );

  await using _server = await bindDisposableHttpServer(server);
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve('bin/share-codiff.mjs'), '--file', walkthroughFile, repositoryPath],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODIFF_SHARE_SERVER_URL: origin,
        HOME: join(directory.path, 'home'),
      },
    },
  );

  const body = uploadedBody as unknown as UploadedBody;
  expect(stdout.trim()).toBe(`${origin}/w/shared-walkthrough`);
  expect(uploadHeaders.authorization).toBe('Bearer secret');
  expect(uploadHeaders['x-codiff-upload-code']).toBe('CODE');
  expect(body.uploader).toMatchObject({
    email: 'author@cloudflare.com',
    name: 'Cloudflare Author',
  });
  expect(body.snapshot).toMatchObject({
    kind: 'codiff-walkthrough-share',
    repository: {
      root: await realpath(repositoryPath),
      source: { type: 'working-tree' },
    },
    version: 1,
    walkthrough: {
      agent: 'codex',
      title: 'Example update',
      version: 4,
    },
  });
});

test('headless plan share works outside Git without invoking it', async () => {
  await using directory = await createTemporaryDirectory('codiff-headless-plan-share-');
  const fakeBin = join(directory.path, 'bin');
  const gitMarker = join(directory.path, 'git-invoked');
  const planFile = join(directory.path, 'plan.md');
  type PlanSnapshot = {
    document: { content: string; name: string; title: string };
    kind: string;
    review: { threads: ReadonlyArray<unknown>; version: number };
    source?: { agent?: string; sessionId?: string };
    version: number;
  };
  type PlanUploadedBody =
    | PlanSnapshot
    | { snapshot: PlanSnapshot; uploader: { email?: string; name: string } };
  let uploadedBody: PlanUploadedBody | null = null;

  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.method === 'POST' && request.url === '/api/upload-intents') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          claimUrl: `${origin}/connect/CODE?secret=secret`,
          code: 'CODE',
          pollUrl: `${origin}/api/upload-intents/CODE?secret=secret`,
          secret: 'secret',
          status: 'claimed',
        }),
      );
      return;
    }

    if (request.method === 'POST' && request.url === '/api/uploads') {
      const chunks: Array<Buffer> = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        uploadedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PlanUploadedBody;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            status: 'uploaded',
            url: `${origin}/p/shared-plan`,
          }),
        );
      });
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/bin/sh\nprintf invoked > "${gitMarker}"\nexit 99\n`);
  await chmod(join(fakeBin, 'git'), 0o755);
  await writeFile(planFile, '# Ship plan sharing\n\nKeep walkthroughs stable.\n');
  await using _server = await bindDisposableHttpServer(server);
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      resolve('bin/share-codiff.mjs'),
      '--plan',
      planFile,
      '--agent',
      'codex',
      '--codex-session',
      'thread-id',
    ],
    {
      cwd: directory.path,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODIFF_SHARE_SERVER_URL: origin,
        HOME: join(directory.path, 'home'),
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
    },
  );

  const body = uploadedBody as PlanUploadedBody | null;
  const snapshot = body && 'snapshot' in body ? body.snapshot : body;
  expect(stdout.trim()).toBe(`${origin}/p/shared-plan`);
  expect(body && 'uploader' in body ? body.uploader : undefined).toBeUndefined();
  expect(await readFile(gitMarker, 'utf8').catch(() => null)).toBeNull();
  expect(snapshot).toMatchObject({
    document: {
      content: '# Ship plan sharing\n\nKeep walkthroughs stable.\n',
      name: 'plan.md',
      title: 'Ship plan sharing',
    },
    kind: 'codiff-plan-share',
    review: {
      threads: [],
      version: 1,
    },
    source: {
      agent: 'codex',
      sessionId: 'thread-id',
    },
    version: 1,
  });
});

test('headless walkthrough share resolves GitHub PR branch targets', async () => {
  await using directory = await createTemporaryDirectory('codiff-headless-pr-branch-');
  const fakeBin = join(directory.path, 'bin');
  const ghArgsPath = join(directory.path, 'gh-args.txt');
  const repositoryPath = join(directory.path, 'repo');
  const walkthroughFile = join(directory.path, 'walkthrough.json');

  await mkdir(fakeBin);
  await mkdir(repositoryPath);
  await writeFile(walkthroughFile, '{}');
  await writeFile(
    join(fakeBin, 'gh'),
    '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$GH_ARGS_FILE"\ndone\nprintf "%s\\n" \'{"state":"MERGED","url":"https://github.com/nkzw-tech/codiff/pull/127"}\'\n',
  );
  await chmod(join(fakeBin, 'gh'), 0o755);

  await using _environment = createTemporaryEnvironment({
    GH_ARGS_FILE: ghArgsPath,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  });
  await expect(
    execFileAsync(
      process.execPath,
      [
        resolve('bin/share-codiff.mjs'),
        '--file',
        walkthroughFile,
        'pr',
        'owner:merged-branch',
        repositoryPath,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GH_ARGS_FILE: ghArgsPath,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      'Could not find an open GitHub pull request for branch "owner:merged-branch".',
    ),
  });
  expect(await readFile(ghArgsPath, 'utf8')).toContain('owner:merged-branch\n');
});

test('codiff --share falls back to HEAD for a clean working tree and prints only its URL', async () => {
  await using directory = await createTemporaryDirectory('codiff-generate-share-');
  const repositoryPath = join(directory.path, 'repo');
  const fakeCodexPath = join(directory.path, 'codex');
  let uploadedBody: UploadedBody | null = null;

  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.method === 'POST' && request.url === '/api/upload-intents') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          claimUrl: `${origin}/connect/CODE?secret=secret`,
          code: 'CODE',
          pollUrl: `${origin}/api/upload-intents/CODE?secret=secret`,
          secret: 'secret',
          status: 'claimed',
        }),
      );
      return;
    }

    if (request.method === 'POST' && request.url === '/api/uploads') {
      const chunks: Array<Buffer> = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        uploadedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as UploadedBody;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            status: 'uploaded',
            url: `${origin}/w/generated-walkthrough`,
          }),
        );
      });
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  await mkdir(repositoryPath);
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'author@cloudflare.com']);
  await git(repositoryPath, ['config', 'user.name', 'Cloudflare Author']);
  await writeFile(join(repositoryPath, 'example.txt'), 'before\n');
  await git(repositoryPath, ['add', 'example.txt']);
  await git(repositoryPath, ['commit', '-m', 'Initial commit']);
  await writeFile(join(repositoryPath, 'example.txt'), 'after\n');
  await git(repositoryPath, ['add', 'example.txt']);
  await git(repositoryPath, ['commit', '-m', 'Update example']);
  const { stdout: headOutput } = await git(repositoryPath, ['rev-parse', 'HEAD']);
  const head = headOutput.trim();

  const state = await readRepositoryState(repositoryPath, { ref: 'HEAD', type: 'commit' });
  const file = state.files[0];
  const hunk = getSectionWalkthroughHunks(file, file.sections[0])[0];
  const generatedWalkthrough = JSON.stringify({
    chapters: [
      {
        blurb: 'Review the committed behavior change.',
        icon: 'wrench',
        id: 'change',
        stops: [
          {
            hunkIds: [hunk.id],
            id: 's1',
            importance: 'normal',
            prose: 'The committed file now contains the updated value.',
          },
        ],
        title: 'Change',
      },
    ],
    focus: 'Update the example value.',
    kind: 'narrative',
    title: 'Example update',
    version: 4,
  });
  await writeFile(
    fakeCodexPath,
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    cat > "$1" <<'EOF'
${generatedWalkthrough}
EOF
    exit 0
  fi
  shift
done
exit 1
`,
  );
  await chmod(fakeCodexPath, 0o755);

  await using _server = await bindDisposableHttpServer(server);
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { stderr, stdout } = await execFileAsync(
    process.execPath,
    [resolve('bin/codiff.js'), '--share', repositoryPath],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODIFF_CODEX_PATH: fakeCodexPath,
        CODIFF_SHARE_SERVER_URL: origin,
        HOME: join(directory.path, 'home'),
      },
    },
  );

  const body = uploadedBody as unknown as UploadedBody;
  expect(stderr).toBe('');
  expect(stdout).toBe(`${origin}/w/generated-walkthrough\n`);
  expect(body.snapshot.repository).toMatchObject({
    root: await realpath(repositoryPath),
    source: { ref: head, type: 'commit' },
    title: 'Update example',
  });
  expect(body.snapshot.walkthrough).toMatchObject({
    agent: 'codex',
    title: 'Example update',
    version: 4,
  });
}, 15_000);
