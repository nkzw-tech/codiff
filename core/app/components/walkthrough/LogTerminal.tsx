import { init as initGhostty, Terminal } from 'ghostty-web';
import { useEffect, useRef, useState } from 'react';

// Cols must match the PTY spawned in electron/walkthrough-commit.cjs so hook
// output wraps where the PTY wrapped it. Agent CLIs run on plain pipes, so
// they inherit the same width for consistent wrapping.
export const TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 12;

// xterm.js's default ANSI palette (Tango); ghostty-web's own defaults differ.
const ANSI_THEME = {
  black: '#2e3436',
  blue: '#3465a4',
  brightBlack: '#555753',
  brightBlue: '#729fcf',
  brightCyan: '#34e2e2',
  brightGreen: '#8ae234',
  brightMagenta: '#ad7fa8',
  brightRed: '#ef2929',
  brightWhite: '#eeeeec',
  brightYellow: '#fce94f',
  cyan: '#06989a',
  green: '#4e9a06',
  magenta: '#75507b',
  red: '#cc0000',
  white: '#d3d7cf',
  yellow: '#c4a000',
};

/**
 * ghostty-web clears rows by painting the theme background, so a transparent
 * background leaves stale glyphs behind; give it the color actually painted
 * behind the terminal instead.
 */
function resolveBackdrop(element: HTMLElement): string {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color !== 'transparent' && !color.startsWith('rgba')) {
      return color;
    }
  }
  return '#00000000';
}

/**
 * Read-only ghostty-web terminal that replays streamed process output, so ANSI
 * colors and cursor movement render as they would in a real shell.
 *
 * `output` must only grow within one mount; remount (with a key) to start a
 * fresh, empty terminal.
 */
export function LogTerminal({
  className = 'wt-log-term',
  output,
  rows = DEFAULT_TERMINAL_ROWS,
}: {
  className?: string;
  output: string;
  rows?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const writtenRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let disposed = false;
    let instance: Terminal | null = null;
    // ghostty-web loads its WASM module asynchronously; output streamed in the
    // meantime is replayed by the write effect once the terminal exists.
    const opened = initGhostty().then(() => {
      if (disposed) {
        return;
      }
      const style = getComputedStyle(container);
      instance = new Terminal({
        cols: TERMINAL_COLS,
        // Piped children emit bare `\n` line endings which would stairstep
        // without this.
        convertEol: true,
        disableStdin: true,
        fontFamily: style.fontFamily,
        fontSize: 12,
        rows,
        theme: {
          ...ANSI_THEME,
          background: resolveBackdrop(container),
          cursor: '#00000000',
          foreground: style.color,
        },
      });
      instance.open(container);
      // open() marks the container contenteditable and focusable for input;
      // this terminal is read-only and the attributes draw a caret on click.
      container.removeAttribute('contenteditable');
      container.removeAttribute('tabindex');
      // A fresh terminal can inherit rows from a previously disposed one:
      // dispose() never frees the WASM-side terminal, and new instances get
      // recycled row memory from the shared WASM module. Erase everything.
      instance.write('\u001B[2J\u001B[3J\u001B[H');
      writtenRef.current = 0;
      setTerminal(instance);
    });
    // Without WASM/canvas support (e.g. jsdom) the log is simply not shown.
    opened.catch(() => {});
    return () => {
      disposed = true;
      instance?.dispose();
      setTerminal(null);
    };
  }, [rows]);

  useEffect(() => {
    if (!terminal || output.length <= writtenRef.current) {
      return;
    }
    terminal.write(output.slice(writtenRef.current));
    writtenRef.current = output.length;
  }, [terminal, output]);

  return <div className={className} ref={containerRef} />;
}
