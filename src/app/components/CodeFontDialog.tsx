import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { XIcon as X } from '@phosphor-icons/react/X';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

type LocalFontData = {
  family: string;
};

type LocalFontWindow = Window & {
  queryLocalFonts?: () => Promise<ReadonlyArray<LocalFontData>>;
};

const defaultFontLabel = 'Default (Fira Code)';
const sampleCode = `function greet(name: string) {
  return \`Hello, \${name}\`;
}`;

const formatFontFamilyStyle = (fontFamily: string): string =>
  fontFamily.trim().length > 0
    ? `${JSON.stringify(fontFamily.trim())}, monospace`
    : 'var(--font-mono)';

export function CodeFontDialog({
  currentFontFamily,
  onClose,
  onSelect,
}: {
  currentFontFamily: string;
  onClose: () => void;
  onSelect: (fontFamily: string) => void;
}) {
  const queryLocalFonts = (window as LocalFontWindow).queryLocalFonts;
  const [availableFontFamilies, setAvailableFontFamilies] = useState<ReadonlyArray<string>>([]);
  const [error, setError] = useState<string | null>(
    queryLocalFonts ? null : 'Local font access is not available in this build of Codiff.',
  );
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(Boolean(queryLocalFonts));
  const [selectedFontFamily, setSelectedFontFamily] = useState(currentFontFamily);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!queryLocalFonts) {
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }

    let cancelled = false;

    queryLocalFonts()
      .then((fonts) => {
        if (cancelled) {
          return;
        }

        const families = [...new Set(fonts.map((font) => font.family.trim()).filter(Boolean))];
        setAvailableFontFamilies(families);
        if (families.length === 0) {
          setError('No local fonts were returned. Permission may be denied.');
        }
      })
      .catch((nextError: unknown) => {
        if (cancelled) {
          return;
        }

        const message =
          nextError instanceof Error ? nextError.message : 'Codiff could not read local fonts.';
        setAvailableFontFamilies([]);
        setError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      });

    return () => {
      cancelled = true;
    };
  }, [queryLocalFonts]);

  const filteredFontFamilies = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) {
      return availableFontFamilies;
    }

    return availableFontFamilies.filter((family) => family.toLowerCase().includes(query));
  }, [availableFontFamilies, filter]);

  const handleOverlayClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  const previewStyle = useMemo<CSSProperties>(
    () => ({ fontFamily: formatFontFamilyStyle(selectedFontFamily) }),
    [selectedFontFamily],
  );

  return (
    <div
      className="code-font-dialog-overlay"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
    >
      <div aria-modal className="code-font-dialog" role="dialog">
        <div className="code-font-dialog-header">
          <div>
            <h2 className="code-font-dialog-title">Choose Code Font</h2>
            <p className="code-font-dialog-subtitle">
              Pick an installed local font family for code diffs.
            </p>
          </div>
          <button
            aria-label="Close dialog"
            className="code-font-dialog-close"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden size={16} weight="bold" />
          </button>
        </div>
        <div className="code-font-dialog-controls">
          <input
            aria-label="Filter code fonts"
            className="code-font-dialog-filter"
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder="Filter fonts"
            ref={inputRef}
            spellCheck={false}
            type="search"
            value={filter}
          />
          <button
            className="code-font-dialog-reset"
            onClick={() => setSelectedFontFamily('')}
            type="button"
          >
            Use Default
          </button>
        </div>
        <div className="code-font-dialog-body">
          <div aria-label="Installed code fonts" className="code-font-dialog-list" role="listbox">
            <button
              aria-selected={selectedFontFamily.length === 0}
              className={`code-font-dialog-option${selectedFontFamily.length === 0 ? ' selected' : ''}`}
              onClick={() => setSelectedFontFamily('')}
              role="option"
              type="button"
            >
              <span className="code-font-dialog-option-name">{defaultFontLabel}</span>
              {selectedFontFamily.length === 0 ? (
                <Check aria-hidden size={14} weight="bold" />
              ) : null}
            </button>
            {filteredFontFamilies.map((family) => (
              <button
                aria-selected={selectedFontFamily === family}
                className={`code-font-dialog-option${selectedFontFamily === family ? ' selected' : ''}`}
                key={family}
                onClick={() => setSelectedFontFamily(family)}
                role="option"
                style={{ fontFamily: formatFontFamilyStyle(family) }}
                type="button"
              >
                <span className="code-font-dialog-option-name">{family}</span>
                {selectedFontFamily === family ? (
                  <Check aria-hidden size={14} weight="bold" />
                ) : null}
              </button>
            ))}
            {!loading && filteredFontFamilies.length === 0 && !error ? (
              <div className="code-font-dialog-empty">No fonts match that filter.</div>
            ) : null}
          </div>
          <div className="code-font-dialog-preview">
            <div className="code-font-dialog-preview-label">Preview</div>
            <pre className="code-font-dialog-preview-code" style={previewStyle}>
              {sampleCode}
            </pre>
            {loading ? <div className="code-font-dialog-status">Loading local fonts…</div> : null}
            {error ? <div className="code-font-dialog-status error">{error}</div> : null}
          </div>
        </div>
        <div className="code-font-dialog-actions">
          <button className="code-font-dialog-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="code-font-dialog-primary"
            onClick={() => onSelect(selectedFontFamily)}
            type="button"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
