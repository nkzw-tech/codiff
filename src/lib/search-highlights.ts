import type { DiffSearchMatch } from './app-types.ts';

const searchMarkSelector = 'mark.codiff-search-mark';

export const clearSearchHighlights = (root: ParentNode) => {
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>(searchMarkSelector))) {
    const parent = mark.parentElement;
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
    parent?.normalize();
  }
};

const getSearchableRoots = (element: HTMLElement): Array<ParentNode> => {
  const roots: Array<ParentNode> = [element];
  if (element.shadowRoot) {
    roots.push(element.shadowRoot);
  }
  return roots;
};

const isNodeInsideSearchMark = (node: Node) =>
  node.parentElement?.closest(searchMarkSelector) != null;

const highlightTextContainer = (
  container: HTMLElement,
  normalizedQuery: string,
  activeMatch: DiffSearchMatch | null,
) => {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent && node.textContent.toLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const textNodes: Array<Text> = [];
  let node = walker.nextNode();
  while (node) {
    if (!isNodeInsideSearchMark(node)) {
      textNodes.push(node as Text);
    }
    node = walker.nextNode();
  }

  const codeColumn = container.closest<HTMLElement>('[data-code]');
  const side: 'additions' | 'deletions' = codeColumn?.hasAttribute('data-deletions')
    ? 'deletions'
    : 'additions';
  const isActiveLine =
    activeMatch?.lineNumber != null &&
    Number(container.dataset.line) === activeMatch.lineNumber &&
    activeMatch.side === side;

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? '';
    const fragment = document.createDocumentFragment();
    let offset = 0;
    let matchIndex = text.toLowerCase().indexOf(normalizedQuery);

    while (matchIndex !== -1) {
      if (matchIndex > offset) {
        fragment.append(document.createTextNode(text.slice(offset, matchIndex)));
      }

      const mark = document.createElement('mark');
      mark.className = `codiff-search-mark${isActiveLine ? ' active' : ''}`;
      mark.textContent = text.slice(matchIndex, matchIndex + normalizedQuery.length);
      fragment.append(mark);
      offset = matchIndex + normalizedQuery.length;
      matchIndex = text.toLowerCase().indexOf(normalizedQuery, offset);
    }

    if (offset < text.length) {
      fragment.append(document.createTextNode(text.slice(offset)));
    }

    textNode.replaceWith(fragment);
  }
};

export const applySearchHighlights = (
  renderedItems: ReadonlyArray<{ element: HTMLElement; id: string }>,
  query: string,
  activeMatch: DiffSearchMatch | null,
) => {
  const normalizedQuery = query.trim().toLowerCase();

  for (const { element, id } of renderedItems) {
    for (const root of getSearchableRoots(element)) {
      clearSearchHighlights(root);

      if (!normalizedQuery) {
        continue;
      }

      const matchForItem = activeMatch && activeMatch.itemId === id ? activeMatch : null;

      for (const container of Array.from(
        root.querySelectorAll<HTMLElement>('[data-code] [data-line]'),
      )) {
        highlightTextContainer(container, normalizedQuery, matchForItem);
      }
    }
  }
};
