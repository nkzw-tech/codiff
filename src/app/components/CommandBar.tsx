import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { getShortcutLabel } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import type { Command } from '../../lib/command-registry.ts';
import { filterCommands } from '../../lib/command-registry.ts';

export function CommandBar({
  commands,
  keymap,
  onClose,
  visible,
}: {
  commands: ReadonlyArray<Command>;
  keymap: CodiffKeymap;
  onClose: () => void;
  visible: boolean;
}) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const filtered = filterCommands(commands, query);

  const clampedIndex = filtered.length === 0 ? -1 : Math.min(selectedIndex, filtered.length - 1);

  const executeAndClose = useCallback(
    (command: Command) => {
      setQuery('');
      setSelectedIndex(0);
      onClose();
      command.execute();
    },
    [onClose],
  );

  const scrollIndexIntoView = useCallback((index: number) => {
    itemRefs.current[index]?.scrollIntoView({ block: 'nearest' });
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuery('');
        setSelectedIndex(0);
        onClose();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((current) => {
          const next = current + 1 >= filtered.length ? 0 : current + 1;
          scrollIndexIntoView(next);
          return next;
        });
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((current) => {
          const next = current - 1 < 0 ? Math.max(filtered.length - 1, 0) : current - 1;
          scrollIndexIntoView(next);
          return next;
        });
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const command = filtered[clampedIndex];
        if (command) {
          executeAndClose(command);
        }
        return;
      }
    },
    [clampedIndex, executeAndClose, filtered, onClose, scrollIndexIntoView],
  );

  const handleOverlayClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        setQuery('');
        setSelectedIndex(0);
        onClose();
      }
    },
    [onClose],
  );

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    setSelectedIndex(0);
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div className="command-bar-overlay" onClick={handleOverlayClick}>
      <div className="command-bar">
        <input
          autoFocus
          className="command-bar-input"
          onChange={(event) => handleQueryChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command..."
          spellCheck={false}
          type="text"
          value={query}
        />
        <div className="command-bar-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="command-bar-empty">No matching commands</div>
          ) : (
            filtered.map((command, index) => (
              <button
                className={`command-bar-item${index === clampedIndex ? ' selected' : ''}`}
                key={command.id}
                onClick={() => executeAndClose(command)}
                onPointerEnter={() => setSelectedIndex(index)}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
              >
                <span className="command-bar-item-title">
                  {command.title}
                  {command.description ? (
                    <span className="command-bar-item-description">{command.description()}</span>
                  ) : null}
                </span>
                {command.keymapAction ? (
                  <kbd className="command-bar-item-shortcut">
                    {getShortcutLabel(keymap, command.keymapAction)}
                  </kbd>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
