import { getFiletypeFromFileName } from '@pierre/diffs';
import { expect, test } from 'vite-plus/test';
import '../lib/code-view-options.ts';

test('registers Node TypeScript module extensions for syntax highlighting', () => {
  expect(getFiletypeFromFileName('src/example.cts')).toBe('typescript');
  expect(getFiletypeFromFileName('src/example.mts')).toBe('typescript');
});
