import dunkelTheme from '../themes/dunkel.json' with { type: 'json' };
import lichtTheme from '../themes/licht.json' with { type: 'json' };

export type IdentifierAtOffset = {
  identifier: string;
  start: number;
};

const identifierPattern = /[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/gu;
const exactIdentifierPattern = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;
const identifierContainedPattern = /[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/u;

// This is intentionally language-agnostic. The modifier treatment is an
// affordance, not a claim that every highlighted token resolves, so keep the
// exclusions to common declaration/control-flow words that are never useful
// navigation targets across Codiff's most common languages.
const commonKeywords = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'def',
  'default',
  'defer',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'fn',
  'for',
  'from',
  'func',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'interface',
  'let',
  'match',
  'mod',
  'namespace',
  'new',
  'nil',
  'none',
  'null',
  'package',
  'pass',
  'private',
  'protected',
  'pub',
  'public',
  'return',
  'self',
  'static',
  'struct',
  'super',
  'switch',
  'this',
  'throw',
  'throws',
  'trait',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'use',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

const identifierNavigationAttribute = 'data-codiff-identifier';
const definitionModifierAttribute = 'data-codiff-definition-mode';
const nonCodeScopePattern = /(^|\s)(comment|string)([.\s]|$)/;
const nonCodeTokenColors = new Set(
  [dunkelTheme, lichtTheme].flatMap((theme) =>
    theme.tokenColors.flatMap((token) => {
      const scopes = Array.isArray(token.scope) ? token.scope : [token.scope];
      const foreground = token.settings.foreground?.toLowerCase();
      return foreground &&
        scopes.some((scope) => typeof scope === 'string' && nonCodeScopePattern.test(scope))
        ? [foreground]
        : [];
    }),
  ),
);

export const isNavigableIdentifierToken = (text: string) => {
  return exactIdentifierPattern.test(text) && !commonKeywords.has(text.toLowerCase());
};

const isNonCodeSyntaxToken = (element: HTMLElement | null) => {
  const style = element?.getAttribute('style')?.toLowerCase() ?? '';
  return [...nonCodeTokenColors].some((color) => style.includes(color));
};

const clearIdentifierNavigationWrappers = (root: ShadowRoot) => {
  for (const wrapper of Array.from(
    root.querySelectorAll<HTMLElement>(`[${identifierNavigationAttribute}]`),
  )) {
    const parent = wrapper.parentElement;
    wrapper.replaceWith(document.createTextNode(wrapper.textContent ?? ''));
    parent?.normalize();
  }
};

const wrapIdentifierNavigationText = (root: ShadowRoot) => {
  const textNodes: Array<Text> = [];
  for (const line of Array.from(root.querySelectorAll<HTMLElement>('[data-line]'))) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        return node.textContent &&
          identifierContainedPattern.test(node.textContent) &&
          !parent?.closest(`[${identifierNavigationAttribute}], mark.codiff-search-mark`) &&
          !isNonCodeSyntaxToken(parent)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node as Text);
      node = walker.nextNode();
    }
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? '';
    const fragment = document.createDocumentFragment();
    let offset = 0;
    let wrapped = false;
    for (const match of text.matchAll(identifierPattern)) {
      const identifier = match[0];
      if (!isNavigableIdentifierToken(identifier)) {
        continue;
      }
      if (match.index > offset) {
        fragment.append(document.createTextNode(text.slice(offset, match.index)));
      }
      const wrapper = document.createElement('span');
      wrapper.setAttribute(identifierNavigationAttribute, '');
      wrapper.textContent = identifier;
      fragment.append(wrapper);
      offset = match.index + identifier.length;
      wrapped = true;
    }
    if (!wrapped) {
      continue;
    }
    if (offset < text.length) {
      fragment.append(document.createTextNode(text.slice(offset)));
    }
    textNode.replaceWith(fragment);
  }
};

export const applyIdentifierNavigationState = (
  renderedItems: ReadonlyArray<{ element: HTMLElement }>,
  active: boolean,
) => {
  for (const { element } of renderedItems) {
    element.toggleAttribute(definitionModifierAttribute, active);
    const root = element.shadowRoot;
    if (!root) {
      continue;
    }

    clearIdentifierNavigationWrappers(root);
    if (active) {
      wrapIdentifierNavigationText(root);
    }
  }
};

export const getIdentifierAtOffset = (text: string, offset: number): IdentifierAtOffset | null => {
  for (const match of text.matchAll(identifierPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset < end) {
      return { identifier: match[0], start };
    }
  }
  return null;
};

export const getIdentifierFromPointerEvent = (
  event: PointerEvent,
  lineElement: HTMLElement,
): string | null => {
  const documentWithCaretRange = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caretRange = documentWithCaretRange.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (caretRange && lineElement.contains(caretRange.startContainer)) {
    const prefix = document.createRange();
    prefix.selectNodeContents(lineElement);
    prefix.setEnd(caretRange.startContainer, caretRange.startOffset);
    const match = getIdentifierAtOffset(lineElement.textContent || '', prefix.toString().length);
    if (match) {
      return match.identifier;
    }
  }

  const target = event.target as Node | null;
  if (target && lineElement.contains(target)) {
    const text = target.textContent || '';
    const matches = [...text.matchAll(identifierPattern)];
    if (matches.length === 1) {
      return matches[0][0];
    }
  }
  return null;
};
