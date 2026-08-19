import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);

const { parseReviewUrl, parseRemoteUrl } = require('../review-source.cjs') as {
  parseRemoteUrl: (value: string) => {
    host: string;
    organization?: string;
    project?: string;
    projectPath: string;
    provider: 'github' | 'gitlab' | 'azure-devops';
    repo?: string;
    webHost?: string;
  } | null;
  parseReviewUrl: (value: string) => {
    host: string;
    number: number;
    organization?: string;
    owner?: string;
    project?: string;
    projectPath: string;
    provider: 'github' | 'gitlab' | 'azure-devops';
    repo?: string;
    url: string;
  } | null;
};

test('parseReviewUrl reads canonical GitHub pull request URLs', () => {
  expect(parseReviewUrl('https://github.com/nkzw-tech/codiff/pull/1728')).toEqual({
    host: 'github.com',
    number: 1728,
    owner: 'nkzw-tech',
    projectPath: 'nkzw-tech/codiff',
    provider: 'github',
    repo: 'codiff',
    url: 'https://github.com/nkzw-tech/codiff/pull/1728',
  });
});

test('parseReviewUrl ignores GitHub tab segments, queries and fragments', () => {
  for (const value of [
    'https://github.com/nkzw-tech/codiff/pull/1728/',
    'https://github.com/nkzw-tech/codiff/pull/1728/changes#r2231',
    'https://github.com/nkzw-tech/codiff/pull/1728/files',
    'https://github.com/nkzw-tech/codiff/pull/1728/files#diff-8a1b2c',
    'https://github.com/nkzw-tech/codiff/pull/1728/commits/0f1e2d3c',
    'https://github.com/nkzw-tech/codiff/pull/1728?diff=split&w=1',
    'https://github.com/nkzw-tech/codiff/pull/1728#issuecomment-4412',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      number: 1728,
      provider: 'github',
      url: 'https://github.com/nkzw-tech/codiff/pull/1728',
    });
  }
});

test('parseReviewUrl accepts GitHub URLs pasted without a scheme or with `www`', () => {
  for (const value of [
    'github.com/nkzw-tech/codiff/pull/1728/changes',
    'www.github.com/nkzw-tech/codiff/pull/1728',
    'https://www.github.com/nkzw-tech/codiff/pull/1728/files',
    'HTTPS://GitHub.com/nkzw-tech/codiff/pull/1728',
    '<https://github.com/nkzw-tech/codiff/pull/1728>',
    '  https://github.com/nkzw-tech/codiff/pull/1728/files  ',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      host: 'github.com',
      number: 1728,
      owner: 'nkzw-tech',
      repo: 'codiff',
      url: 'https://github.com/nkzw-tech/codiff/pull/1728',
    });
  }
});

test('parseReviewUrl strips a `.git` suffix from GitHub repositories', () => {
  expect(parseReviewUrl('https://github.com/nkzw-tech/codiff.git/pull/1728')).toMatchObject({
    projectPath: 'nkzw-tech/codiff',
    repo: 'codiff',
    url: 'https://github.com/nkzw-tech/codiff/pull/1728',
  });
});

test('parseReviewUrl reads GitLab merge request URLs on arbitrary hosts', () => {
  expect(
    parseReviewUrl('https://gitlab.example.com/group/subgroup/project/-/merge_requests/23'),
  ).toEqual({
    host: 'gitlab.example.com',
    number: 23,
    projectPath: 'group/subgroup/project',
    provider: 'gitlab',
    url: 'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23',
  });
});

test('parseReviewUrl ignores GitLab tab segments, queries and fragments', () => {
  for (const value of [
    'https://gitlab.example.com/group/project/-/merge_requests/23/',
    'https://gitlab.example.com/group/project/-/merge_requests/23/diffs',
    'https://gitlab.example.com/group/project/-/merge_requests/23/diffs#note_9182',
    'https://gitlab.example.com/group/project/-/merge_requests/23/commits',
    'https://gitlab.example.com/group/project/-/merge_requests/23/pipelines',
    'https://gitlab.example.com/group/project/-/merge_requests/23?commit_id=0f1e2d3c',
    'gitlab.example.com/group/project/-/merge_requests/23/diffs',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      number: 23,
      projectPath: 'group/project',
      provider: 'gitlab',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
    });
  }
});

test('parseReviewUrl reads legacy GitLab merge request URLs without the `/-/` segment', () => {
  expect(
    parseReviewUrl('https://gitlab.example.com/group/project/merge_requests/23/diffs'),
  ).toMatchObject({
    number: 23,
    projectPath: 'group/project',
    provider: 'gitlab',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
  });
});

test('parseReviewUrl rejects values that are not review URLs', () => {
  for (const value of [
    '',
    'main',
    'feature/pull/1',
    'https://github.com/nkzw-tech/codiff',
    'https://github.com/nkzw-tech/codiff/pull/0',
    'https://github.com/nkzw-tech/codiff/pull/abc',
    'https://github.com/nkzw-tech/codiff/issues/1728',
    'https://example.com/nkzw-tech/codiff/pull/1728',
    'https://dev.azure.com/org/project/_git/repo',
    'some/local/path/merge_requests/23',
  ]) {
    expect(parseReviewUrl(value)).toBe(null);
  }
});

test('parseReviewUrl reads Azure DevOps pull request URLs', () => {
  expect(
    parseReviewUrl('https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492'),
  ).toMatchObject({
    host: 'dev.azure.com',
    number: 492,
    organization: 'mpc-tech-hub',
    project: 'MPCM',
    projectPath: 'mpc-tech-hub/MPCM/Dashboard',
    provider: 'azure-devops',
    repo: 'Dashboard',
    url: 'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
  });
});

test('parseReviewUrl ignores Azure DevOps tab segments, queries and fragments', () => {
  for (const value of [
    'https://dev.azure.com/org/project/_git/repo/pullrequest/42/',
    'https://dev.azure.com/org/project/_git/repo/pullrequest/42?_a=files',
    'https://dev.azure.com/org/project/_git/repo/pullrequest/42?discussionId=18',
    'https://dev.azure.com/org/project/_git/repo/pullrequest/42#_a=overview',
    'dev.azure.com/org/project/_git/repo/pullrequest/42?path=/src/a.ts',
    '<https://dev.azure.com/org/project/_git/repo/pullRequest/42>',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      number: 42,
      provider: 'azure-devops',
      url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
    });
  }
});

test('parseReviewUrl reads visualstudio.com Azure DevOps pull request URLs', () => {
  expect(
    parseReviewUrl('https://contoso.visualstudio.com/Fabrikam/_git/Widgets/pullrequest/9'),
  ).toMatchObject({
    host: 'contoso.visualstudio.com',
    number: 9,
    organization: 'contoso',
    project: 'Fabrikam',
    provider: 'azure-devops',
    repo: 'Widgets',
    url: 'https://contoso.visualstudio.com/Fabrikam/_git/Widgets/pullrequest/9',
  });
});

test('parseRemoteUrl classifies Azure DevOps HTTPS and SSH remotes', () => {
  expect(parseRemoteUrl('https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard')).toMatchObject({
    organization: 'mpc-tech-hub',
    project: 'MPCM',
    provider: 'azure-devops',
    repo: 'Dashboard',
    webHost: 'dev.azure.com',
  });
  expect(parseRemoteUrl('git@ssh.dev.azure.com:v3/mpc-tech-hub/MPCM/Dashboard')).toMatchObject({
    organization: 'mpc-tech-hub',
    project: 'MPCM',
    provider: 'azure-devops',
    repo: 'Dashboard',
    webHost: 'dev.azure.com',
  });
  expect(
    parseRemoteUrl('git@vs-ssh.visualstudio.com:v3/contoso/Fabrikam/Widgets.git'),
  ).toMatchObject({
    organization: 'contoso',
    project: 'Fabrikam',
    provider: 'azure-devops',
    repo: 'Widgets',
    webHost: 'contoso.visualstudio.com',
  });
  expect(
    parseRemoteUrl('vsshadmin@contoso@vs-ssh.visualstudio.com:v3/contoso/Fabrikam/Widgets.git'),
  ).toMatchObject({
    organization: 'contoso',
    project: 'Fabrikam',
    provider: 'azure-devops',
    repo: 'Widgets',
    webHost: 'contoso.visualstudio.com',
  });
});
