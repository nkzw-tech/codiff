declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

if (typeof window !== 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: createMemoryStorage(),
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: createMemoryStorage(),
  });
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () =>
    ({
      addEventListener() {},
      addListener() {},
      dispatchEvent: () => false,
      matches: false,
      media: '',
      onchange: null,
      removeEventListener() {},
      removeListener() {},
    }) as MediaQueryList;
}

function scrollTo(this: HTMLElement, optionsOrX?: ScrollToOptions | number, y?: number) {
  const nextLeft =
    typeof optionsOrX === 'number' ? optionsOrX : (optionsOrX?.left ?? this.scrollLeft);
  const nextTop =
    typeof optionsOrX === 'number' ? (y ?? this.scrollTop) : (optionsOrX?.top ?? this.scrollTop);

  this.scrollLeft = nextLeft;
  this.scrollTop = nextTop;
}

if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = scrollTo;
}

if (typeof HTMLElement !== 'undefined') {
  const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getTestBoundingClientRect() {
    const rect = getBoundingClientRect.call(this);

    if (rect.height === 0 && this.classList.contains('code-view')) {
      return new DOMRect(rect.x, rect.y, rect.width || 1024, 768);
    }

    return rect;
  };
}

if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}

    disconnect() {}

    observe() {}

    unobserve() {}
  };
}

if (typeof Range !== 'undefined') {
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
}
