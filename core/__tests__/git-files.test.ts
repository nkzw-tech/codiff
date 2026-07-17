import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import { removeGitTestDirectory } from './helpers/git.ts';
import { createTemporaryEnvironment } from './helpers/resources.ts';

type FileContentResult = {
  binary: boolean;
  file?: {
    cacheKey: string;
    contents: string;
    name: string;
  };
  fingerprint?: string;
  loadState?: string;
  summary?: {
    canLoad?: boolean;
    size?: number;
  };
};

type GitFilesModule = {
  readGitFiles: (
    repoRoot: string,
    ref: string,
    paths: ReadonlyArray<string>,
    options?: { refScopedEmptyCacheKey?: boolean },
  ) => Promise<Map<string, FileContentResult>>;
};

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { readGitFiles } = require('../../electron/git-state/git-files.cjs') as GitFilesModule;
const batchCases = [
  { fileCount: 20, maximumProcesses: 6 },
  { fileCount: 160, maximumProcesses: 6 },
  { fileCount: 500, maximumProcesses: 10 },
] as const;

let base = '';
let head = '';
let repo = '';

const git = async (repository: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

const fastImport = async (repository: string, input: Buffer) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', repository, 'fast-import', '--quiet'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `git fast-import exited with code ${code}.`));
      }
    });
    child.stdin.end(input);
  });
};

const createGitHistory = async (repository: string) => {
  const chunks: Array<Buffer> = [];
  let nextMark = 1;
  const addBlob = (contents: string | Uint8Array) => {
    const mark = nextMark;
    nextMark += 1;
    const buffer = Buffer.from(contents);
    chunks.push(
      Buffer.from(`blob\nmark :${mark}\ndata ${buffer.length}\n`),
      buffer,
      Buffer.from('\n'),
    );
    return mark;
  };
  const addCommit = (
    ref: string,
    message: string,
    commands: ReadonlyArray<string>,
    parent?: number,
  ) => {
    const mark = nextMark;
    nextMark += 1;
    chunks.push(
      Buffer.from(
        [
          `commit ${ref}`,
          `mark :${mark}`,
          'committer Codiff Test <codiff@example.com> 0 +0000',
          `data ${Buffer.byteLength(message)}`,
          message,
          ...(parent == null ? [] : [`from :${parent}`]),
          ...commands,
          '',
        ].join('\n'),
      ),
    );
    return mark;
  };

  const baseCommands = [
    `M 100644 :${addBlob('before\n')} modified.txt`,
    `M 100644 :${addBlob('rename before\n')} renamed-old.txt`,
    `M 100644 :${addBlob('deleted\n')} deleted.txt`,
    `M 100644 :${addBlob(Uint8Array.from([0, 1, 2, 3]))} binary.bin`,
    `M 100644 :${addBlob('literal before\n')} literal-:(name).txt`,
    ...Array.from(
      { length: 500 },
      (_, index) =>
        `M 100644 :${addBlob(`base ${index}\n`)} src/file-${index.toString().padStart(3, '0')}.ts`,
    ),
  ];
  const baseCommit = addCommit('refs/heads/base', 'base', baseCommands);
  const headCommands = [
    `M 100644 :${addBlob('after\n')} modified.txt`,
    'D renamed-old.txt',
    `M 100644 :${addBlob('rename after\n')} renamed-new.txt`,
    'D deleted.txt',
    `M 100644 :${addBlob('added\n')} added.txt`,
    `M 100644 :${addBlob(Uint8Array.from([0, 4, 5, 6]))} binary.bin`,
    `M 100644 :${addBlob('literal after\n')} literal-:(name).txt`,
    `M 100644 :${addBlob('m'.repeat(1024 * 1024 + 1))} medium.txt`,
    `M 100644 :${addBlob('h'.repeat(2 * 1024 * 1024 + 1))} huge.txt`,
    ...Array.from(
      { length: 500 },
      (_, index) =>
        `M 100644 :${addBlob(`head ${index}\n`)} src/file-${index.toString().padStart(3, '0')}.ts`,
    ),
  ];
  addCommit('refs/heads/head', 'head', headCommands, baseCommit);
  chunks.push(Buffer.from('done\n'));
  await fastImport(repository, Buffer.concat(chunks));
};

beforeAll(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'codiff-git-files-')));
  await git(repo, ['init']);
  await createGitHistory(repo);
  base = (await git(repo, ['rev-parse', 'refs/heads/base'])).trim();
  head = (await git(repo, ['rev-parse', 'refs/heads/head'])).trim();
});

afterAll(async () => {
  if (repo) {
    await removeGitTestDirectory(repo);
  }
});

test('batched Git file reads preserve text, binary, rename, missing, and size behavior', async () => {
  const oldPaths = [
    'modified.txt',
    'renamed-old.txt',
    'deleted.txt',
    'added.txt',
    'binary.bin',
    'medium.txt',
    'huge.txt',
    'missing.txt',
    'literal-:(name).txt',
  ];
  const newPaths = [
    'modified.txt',
    'renamed-new.txt',
    'deleted.txt',
    'added.txt',
    'binary.bin',
    'medium.txt',
    'huge.txt',
    'missing.txt',
    'literal-:(name).txt',
  ];
  const [oldFiles, newFiles] = await Promise.all([
    readGitFiles(repo, base, oldPaths, { refScopedEmptyCacheKey: true }),
    readGitFiles(repo, head, newPaths, { refScopedEmptyCacheKey: true }),
  ]);

  expect(oldFiles.get('modified.txt')?.file?.contents).toBe('before\n');
  expect(newFiles.get('modified.txt')?.file?.contents).toBe('after\n');
  expect(oldFiles.get('renamed-old.txt')?.file?.contents).toBe('rename before\n');
  expect(newFiles.get('renamed-new.txt')?.file?.contents).toBe('rename after\n');
  expect(oldFiles.get('deleted.txt')?.file?.contents).toBe('deleted\n');
  expect(newFiles.get('deleted.txt')?.file).toEqual({
    cacheKey: `${head}:deleted.txt:empty`,
    contents: '',
    name: 'deleted.txt',
  });
  expect(oldFiles.get('added.txt')?.file).toEqual({
    cacheKey: `${base}:added.txt:empty`,
    contents: '',
    name: 'added.txt',
  });
  expect(newFiles.get('added.txt')?.file?.contents).toBe('added\n');
  expect(oldFiles.get('binary.bin')).toMatchObject({ binary: true });
  expect(newFiles.get('binary.bin')).toMatchObject({ binary: true });
  expect(newFiles.get('binary.bin')?.fingerprint).not.toBe(oldFiles.get('binary.bin')?.fingerprint);
  expect(newFiles.get('medium.txt')).toMatchObject({
    binary: false,
    loadState: 'deferred',
    summary: { canLoad: true, size: 1024 * 1024 + 1 },
  });
  expect(newFiles.get('medium.txt')?.file).toBeUndefined();
  expect(newFiles.get('huge.txt')).toMatchObject({
    binary: false,
    loadState: 'too-large',
    summary: { canLoad: false, size: 2 * 1024 * 1024 + 1 },
  });
  expect(newFiles.get('huge.txt')?.file).toBeUndefined();
  expect(newFiles.get('missing.txt')?.file?.cacheKey).toBe(`${head}:missing.txt:empty`);
  expect(oldFiles.get('literal-:(name).txt')?.file?.contents).toBe('literal before\n');
  expect(newFiles.get('literal-:(name).txt')?.file?.contents).toBe('literal after\n');
});

test.each(batchCases)(
  'batches pull request content reads for $fileCount files',
  async ({ fileCount, maximumProcesses }) => {
    const tracePath = join(repo, `trace-${fileCount}.jsonl`);
    await using _environment = createTemporaryEnvironment({ GIT_TRACE2_EVENT: tracePath });

    const paths = Array.from(
      { length: fileCount },
      (_, index) => `src/file-${index.toString().padStart(3, '0')}.ts`,
    );
    const [oldFiles, newFiles] = await Promise.all([
      readGitFiles(repo, base, paths, { refScopedEmptyCacheKey: true }),
      readGitFiles(repo, head, paths, { refScopedEmptyCacheKey: true }),
    ]);

    expect(oldFiles).toHaveLength(fileCount);
    expect(newFiles).toHaveLength(fileCount);

    const processCount = (await readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string })
      .filter(({ event }) => event === 'version').length;
    expect(processCount).toBeLessThanOrEqual(maximumProcesses);
  },
);
