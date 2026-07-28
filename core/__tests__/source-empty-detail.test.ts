import { expect, test } from 'vite-plus/test';
import { getEmptySourceDetail } from '../lib/source.ts';

test('shows the complete repository path when the working tree has no changes', () => {
  expect(getEmptySourceDetail({ type: 'working-tree' }, '/Users/hafez/dev/websites/blog')).toEqual({
    kind: 'code',
    text: '~/dev/websites/blog',
    title: '/Users/hafez/dev/websites/blog',
  });
});
