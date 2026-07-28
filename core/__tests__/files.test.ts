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

test('handles the home directory itself and short paths', () => {
  expect(splitRepositoryPath('/Users/hafez')).toEqual({ head: '', tail: '~' });
  expect(splitRepositoryPath('~/blog')).toEqual({ head: '~', tail: '/blog' });
});
