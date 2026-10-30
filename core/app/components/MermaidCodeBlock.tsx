import {
  appendCodeBlockEditorDescriptor$,
  type CodeBlockEditorDescriptor,
  type CodeBlockEditorProps,
  CodeMirrorEditor,
  realmPlugin,
} from '@nkzw/mdx-editor/core';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react/ArrowCounterClockwise';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { CaretLeftIcon as CaretLeft } from '@phosphor-icons/react/CaretLeft';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/CaretRight';
import { CaretUpIcon as CaretUp } from '@phosphor-icons/react/CaretUp';
import { CodeIcon as Code } from '@phosphor-icons/react/Code';
import { FlowArrowIcon as FlowArrow } from '@phosphor-icons/react/FlowArrow';
import { MagnifyingGlassMinusIcon as MagnifyingGlassMinus } from '@phosphor-icons/react/MagnifyingGlassMinus';
import { MagnifyingGlassPlusIcon as MagnifyingGlassPlus } from '@phosphor-icons/react/MagnifyingGlassPlus';
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  getCachedMermaidDiagram,
  getWheelZoomFactor,
  initialMermaidView,
  type MermaidDiagram,
  type MermaidTheme,
  renderMermaidDiagram,
  zoomMermaidView,
} from '../../lib/mermaid.ts';
import { CopyCodeButton } from './CopyCodeButton.tsx';

const panStep = 100;
const zoomStep = 1.25;

const getMermaidTheme = (element: Element | null): MermaidTheme =>
  element && getComputedStyle(element).colorScheme === 'dark' ? 'dark' : 'default';

function useMermaidTheme(ref: RefObject<HTMLElement | null>) {
  const [theme, setTheme] = useState<MermaidTheme | null>(null);

  useLayoutEffect(() => {
    const update = () => setTheme(getMermaidTheme(ref.current));
    update();

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'], subtree: true });
    return () => {
      media.removeEventListener('change', update);
      observer.disconnect();
    };
  }, [ref]);

  return theme;
}

function ControlButton({
  children,
  className,
  label,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={`codiff-mermaid-control${className ? ` ${className}` : ''}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function MermaidActions({
  code,
  onToggleSource,
  showSource,
}: {
  code: string;
  onToggleSource: () => void;
  showSource: boolean;
}) {
  return (
    <div aria-label="Diagram actions" className="codiff-mermaid-actions" role="group">
      <ControlButton label={showSource ? 'Show diagram' : 'Show source'} onClick={onToggleSource}>
        {showSource ? (
          <FlowArrow aria-hidden size={16} weight="bold" />
        ) : (
          <Code aria-hidden size={16} weight="bold" />
        )}
      </ControlButton>
      <CopyCodeButton className="codiff-mermaid-control" code={code} />
    </div>
  );
}

function MermaidViewer({ actions, diagram }: { actions: ReactNode; diagram: MermaidDiagram }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState(initialMermaidView);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    // Registered natively because React's wheel listener is passive and can't stop page zoom.
    const zoomOnWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = getWheelZoomFactor(event);
      setView((current) =>
        zoomMermaidView(current, factor, event.clientX - rect.left, event.clientY - rect.top),
      );
    };
    viewport.addEventListener('wheel', zoomOnWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', zoomOnWheel);
  }, []);

  const zoom = (factor: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    setView((current) =>
      zoomMermaidView(current, factor, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2),
    );
  };
  const pan = (x: number, y: number) =>
    setView((current) => ({ ...current, x: current.x + x, y: current.y + y }));
  const reset = () => setView(initialMermaidView);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }
  };

  return (
    <div className="codiff-mermaid-viewer">
      <div
        className={`codiff-mermaid-viewport${dragging ? ' dragging' : ''}`}
        onDoubleClick={reset}
        onPointerCancel={endDrag}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag?.pointerId !== event.pointerId) {
            return;
          }
          dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
          pan(event.clientX - drag.x, event.clientY - drag.y);
        }}
        onPointerUp={endDrag}
        ref={viewportRef}
      >
        <img
          alt="Mermaid diagram"
          className="codiff-mermaid-diagram"
          decoding="async"
          draggable={false}
          height={diagram.height}
          src={diagram.src}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          width={diagram.width}
        />
      </div>
      {actions}
      <div aria-label="Zoom and pan" className="codiff-mermaid-pan-zoom" role="group">
        <ControlButton className="zoom-in" label="Zoom in" onClick={() => zoom(zoomStep)}>
          <MagnifyingGlassPlus aria-hidden size={16} weight="bold" />
        </ControlButton>
        <ControlButton className="zoom-out" label="Zoom out" onClick={() => zoom(1 / zoomStep)}>
          <MagnifyingGlassMinus aria-hidden size={16} weight="bold" />
        </ControlButton>
        <ControlButton className="reset" label="Reset view" onClick={reset}>
          <ArrowCounterClockwise aria-hidden size={16} weight="bold" />
        </ControlButton>
        <ControlButton className="up" label="Pan up" onClick={() => pan(0, panStep)}>
          <CaretUp aria-hidden size={16} weight="bold" />
        </ControlButton>
        <ControlButton className="down" label="Pan down" onClick={() => pan(0, -panStep)}>
          <CaretDown aria-hidden size={16} weight="bold" />
        </ControlButton>
        <ControlButton className="left" label="Pan left" onClick={() => pan(panStep, 0)}>
          <CaretLeft aria-hidden size={16} weight="bold" />
        </ControlButton>
        <ControlButton className="right" label="Pan right" onClick={() => pan(-panStep, 0)}>
          <CaretRight aria-hidden size={16} weight="bold" />
        </ControlButton>
      </div>
    </div>
  );
}

function MermaidCodeBlock(props: CodeBlockEditorProps) {
  const { code } = props;
  const ref = useRef<HTMLDivElement>(null);
  const theme = useMermaidTheme(ref);
  const [rendered, setRendered] = useState<{
    code: string;
    diagram: MermaidDiagram | null;
  } | null>(null);
  const [showSource, setShowSource] = useState(false);
  const cached = theme ? getCachedMermaidDiagram(code, theme) : null;

  useEffect(() => {
    if (!theme || cached) {
      return;
    }

    let cancelled = false;
    renderMermaidDiagram(code, theme).then(
      (diagram) => !cancelled && setRendered({ code, diagram }),
      () => !cancelled && setRendered({ code, diagram: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [cached, code, theme]);

  // A diagram from the previous theme stays visible until the new one is ready.
  const diagram = cached ?? (rendered?.code === code ? rendered.diagram : undefined);
  const actions = (
    <MermaidActions
      code={code}
      onToggleSource={() => setShowSource((current) => !current)}
      showSource={showSource}
    />
  );

  return (
    <div className="codiff-mermaid-block" ref={ref}>
      {theme == null ? null : diagram && showSource ? (
        <div className="codiff-mermaid-source">
          <CodeMirrorEditor {...props} />
          {actions}
        </div>
      ) : diagram ? (
        <MermaidViewer actions={actions} diagram={diagram} key={code} />
      ) : (
        <>
          <CodeMirrorEditor {...props} />
          {diagram === null ? (
            <div className="codiff-mermaid-error">Unable to render Mermaid diagram</div>
          ) : null}
        </>
      )}
    </div>
  );
}

const mermaidDescriptor: CodeBlockEditorDescriptor = {
  Editor: MermaidCodeBlock,
  match: (language) => language?.toLowerCase() === 'mermaid',
  priority: 2,
};

export const mermaidPlugin = realmPlugin({
  init: (realm) => realm.pub(appendCodeBlockEditorDescriptor$, mermaidDescriptor),
});
