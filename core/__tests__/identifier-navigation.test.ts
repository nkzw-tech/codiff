/**
 * @vitest-environment jsdom
 */

import { expect, test } from 'vite-plus/test';
import {
  applyIdentifierNavigationState,
  getIdentifierAtOffset,
  getIdentifierFromPointerEvent,
  isNavigableIdentifierToken,
} from '../lib/identifier-navigation.ts';

test('finds identifiers at either edge of the clicked token', () => {
  expect(getIdentifierAtOffset('return formatGreeting(name)', 8)).toEqual({
    identifier: 'formatGreeting',
    start: 7,
  });
  expect(getIdentifierAtOffset('return formatGreeting(name)', 20)?.identifier).toBe(
    'formatGreeting',
  );
  expect(getIdentifierAtOffset('return formatGreeting(name)', 6)).toBeNull();
});

test('uses a syntax-token element as a pointer lookup fallback', () => {
  const line = document.createElement('div');
  const token = document.createElement('span');
  token.textContent = 'formatGreeting';
  line.append('return ', token, '(name)');

  expect(
    getIdentifierFromPointerEvent(
      { clientX: 0, clientY: 0, target: token } as unknown as PointerEvent,
      line,
    ),
  ).toBe('formatGreeting');
});

test('only treats identifier-shaped non-keyword tokens as navigation candidates', () => {
  expect(isNavigableIdentifierToken('formatGreeting')).toBe(true);
  expect(isNavigableIdentifierToken('$value')).toBe(true);
  expect(isNavigableIdentifierToken('return')).toBe(false);
  expect(isNavigableIdentifierToken('name:')).toBe(false);
});

test('applies and clears the modifier affordance inside rendered diff shadow roots', () => {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const line = document.createElement('div');
  line.dataset.line = '1';
  const syntaxToken = document.createElement('span');
  syntaxToken.textContent = '  return formatGreeting(name).value;';
  const commentToken = document.createElement('span');
  commentToken.setAttribute('style', '--diffs-token-dark:#919191');
  commentToken.textContent = ' // do not navigate these words';
  line.append(syntaxToken, commentToken);
  root.append(line);

  applyIdentifierNavigationState([{ element: host }], true);
  expect(host.hasAttribute('data-codiff-definition-mode')).toBe(true);
  expect(
    Array.from(root.querySelectorAll<HTMLElement>('[data-codiff-identifier]')).map(
      (element) => element.textContent,
    ),
  ).toEqual(['formatGreeting', 'name', 'value']);
  expect(line.textContent).toBe(
    '  return formatGreeting(name).value; // do not navigate these words',
  );

  applyIdentifierNavigationState([{ element: host }], false);
  expect(host.hasAttribute('data-codiff-definition-mode')).toBe(false);
  expect(root.querySelector('[data-codiff-identifier]')).toBeNull();
  expect(line.textContent).toBe(
    '  return formatGreeting(name).value; // do not navigate these words',
  );
});
