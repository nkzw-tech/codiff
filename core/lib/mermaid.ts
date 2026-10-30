import type { Mermaid } from 'mermaid';

export type MermaidTheme = 'dark' | 'default';

export type MermaidDiagram = {
  height?: number;
  src: string;
  width?: number;
};

export type MermaidView = { scale: number; x: number; y: number };

export const initialMermaidView: MermaidView = { scale: 1, x: 0, y: 0 };

const minScale = 0.5;
const maxScale = 8;

// Scales around the origin so the point under it stays put.
export const zoomMermaidView = (
  view: MermaidView,
  factor: number,
  originX: number,
  originY: number,
): MermaidView => {
  const scale = Math.min(Math.max(view.scale * factor, minScale), maxScale);
  const ratio = scale / view.scale;
  return {
    scale,
    x: originX - (originX - view.x) * ratio,
    y: originY - (originY - view.y) * ratio,
  };
};

// d3-zoom's default wheel delta; trackpad pinches arrive as Ctrl+wheel with small deltas.
// Capped at 2× per event so a Ctrl+mouse-wheel notch doesn't jump straight to the limit.
export const getWheelZoomFactor = ({
  ctrlKey,
  deltaMode,
  deltaY,
}: Pick<WheelEvent, 'ctrlKey' | 'deltaMode' | 'deltaY'>) => {
  const delta = -deltaY * (deltaMode === 1 ? 0.05 : deltaMode ? 1 : 0.002) * (ctrlKey ? 10 : 1);
  return 2 ** Math.min(Math.max(delta, -1), 1);
};

const cacheLimit = 50;
const cache = new Map<string, MermaidDiagram>();

let mermaidModule: Promise<Mermaid> | undefined;
let initializedTheme: MermaidTheme | null = null;
let queue: Promise<unknown> = Promise.resolve();
let renderCount = 0;

const getCacheKey = (code: string, theme: MermaidTheme) => `${theme}\n${code}`;

const loadMermaid = () =>
  (mermaidModule ??= import('mermaid').then(
    ({ default: mermaid }) => mermaid,
    (error: unknown) => {
      mermaidModule = undefined;
      throw error;
    },
  ));

export const getSvgSize = (svg: string): { height: number; width: number } | undefined => {
  const viewBox = /<svg\b[^>]*?\sviewBox\s*=\s*["']([^"']+)["']/i.exec(svg)?.[1];
  const [, , width, height] =
    viewBox
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  return width && height && Number.isFinite(width) && Number.isFinite(height)
    ? { height: Math.ceil(height), width: Math.ceil(width) }
    : undefined;
};

export const toSvgDataUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const getCachedMermaidDiagram = (code: string, theme: MermaidTheme) => {
  const key = getCacheKey(code, theme);
  const diagram = cache.get(key);
  if (diagram) {
    cache.delete(key);
    cache.set(key, diagram);
  }
  return diagram ?? null;
};

// Renders run one at a time: Mermaid's config is global and each render mounts a temporary node.
export const renderMermaidDiagram = (code: string, theme: MermaidTheme) => {
  const cached = getCachedMermaidDiagram(code, theme);
  if (cached) {
    return Promise.resolve(cached);
  }

  const result = queue.then(async () => {
    const key = getCacheKey(code, theme);
    const queued = cache.get(key);
    if (queued) {
      return queued;
    }

    const mermaid = await loadMermaid();
    if (initializedTheme !== theme) {
      mermaid.initialize({
        htmlLabels: false,
        layout: 'dagre',
        secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), 'htmlLabels'],
        securityLevel: 'strict',
        startOnLoad: false,
        suppressErrorRendering: true,
        theme,
      });
      initializedTheme = theme;
    }

    // Inspect the parsed nodes, rather than matching source text: image metadata is YAML.
    // Mermaid waits for image downloads even in strict mode, before returning its SVG.
    // Reject image nodes before rendering so an untrusted URL can't stall the shared queue.
    if (code.length > (mermaid.mermaidAPI.defaultConfig.maxTextSize ?? 50_000)) {
      throw new Error('Mermaid diagram is too large');
    }
    mermaid.mermaidAPI.reset();
    const parsed = await mermaid.mermaidAPI.getDiagramFromText(code);
    const db = parsed.db as { getVertices?: () => Map<string, { img?: string }> };
    if (db.getVertices && [...db.getVertices().values()].some((node) => node.img)) {
      throw new Error('Images are not supported in Mermaid diagrams');
    }

    const { svg } = await mermaid.render(`codiff-mermaid-${++renderCount}`, code);
    const diagram: MermaidDiagram = { ...getSvgSize(svg), src: toSvgDataUrl(svg) };
    cache.set(key, diagram);
    if (cache.size > cacheLimit) {
      cache.delete(cache.keys().next().value!);
    }
    return diagram;
  });

  queue = result.catch(() => {});
  return result;
};
