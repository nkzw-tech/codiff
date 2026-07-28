import { expect, test } from 'vite-plus/test';
import { splitRepositoryPath } from '../lib/files.ts';

test('splits a home repository path into a head and a repository tail', () => {
  expect(splitRepositoryPath('/Users/hafez/dev/websites/blog')).toEqual({
    head: '~/dev/websites',
    tail: '/blog',
  });
  expect(splitRepositoryPath('/home/ada/projects/analytical-engine')).toEqual({
    head: '~/projects',
    tail: '/analytical-engine',
  });
});

test('keeps paths outside the home directory absolute', () => {
  expect(splitRepositoryPath('/srv/git/deploy-tools')).toEqual({
    head: '/srv/git',
    tail: '/deploy-tools',
  });
  expect(splitRepositoryPath('/repo')).toEqual({ head: '', tail: '/repo' });
});

test('splits and abbreviates Windows repository paths', () => {
  expect(splitRepositoryPath(String.raw`C:\Users\Ada\dev\analytical-engine`)).toEqual({
    head: String.raw`~\dev`,
    tail: String.raw`\analytical-engine`,
  });
  expect(splitRepositoryPath('C:/Users/Ada/dev/analytical-engine')).toEqual({
    head: '~/dev',
    tail: '/analytical-engine',
  });
  expect(splitRepositoryPath(String.raw`D:\srv\deploy-tools`)).toEqual({
    head: String.raw`D:\srv`,
    tail: String.raw`\deploy-tools`,
  });
});

test('handles the home directory itself and short paths', () => {
  expect(splitRepositoryPath('/Users/hafez')).toEqual({ head: '', tail: '~' });
  expect(splitRepositoryPath('~/blog')).toEqual({ head: '~', tail: '/blog' });
});
