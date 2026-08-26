import { Dialog } from '@base-ui/react/dialog';
import type { CodiffPreferences } from '@nkzw/codiff-core';
import { Button } from '@nkzw/codiff-core/react';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react/ArrowCounterClockwise';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { GearSixIcon as GearSix } from '@phosphor-icons/react/GearSix';
import { MinusIcon as Minus } from '@phosphor-icons/react/Minus';
import { PlusIcon as Plus } from '@phosphor-icons/react/Plus';
import { XIcon as X } from '@phosphor-icons/react/X';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

export type OnlineCodiffPreferences = Pick<
  CodiffPreferences,
  'codeFontFamily' | 'codeFontSize' | 'diffStyle' | 'showWhitespace' | 'theme' | 'wordWrap'
>;

const CODE_FONT_SIZE_DEFAULT = 13;
const CODE_FONT_SIZE_MIN = 10;
const CODE_FONT_SIZE_MAX = 32;
const mobileReviewMediaQuery = '(max-width: 720px)';
export const onlineCodiffPreferencesKey = 'codiff:web-review-preferences:v1';

export const defaultOnlineCodiffPreferences = {
  codeFontFamily: 'Fira Code',
  codeFontSize: CODE_FONT_SIZE_DEFAULT,
  diffStyle: 'split',
  showWhitespace: false,
  theme: 'system',
  wordWrap: false,
} satisfies OnlineCodiffPreferences;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const clampCodeFontSize = (size: number) =>
  Number.isFinite(size)
    ? Math.min(CODE_FONT_SIZE_MAX, Math.max(CODE_FONT_SIZE_MIN, Math.round(size)))
    : CODE_FONT_SIZE_DEFAULT;

const isSafeCodeFontFamily = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && /^[\w\s,'"-]+$/.test(value);

const sanitizeOnlineCodiffPreferences = (
  preferences: OnlineCodiffPreferences,
): OnlineCodiffPreferences => ({
  ...preferences,
  codeFontFamily: isSafeCodeFontFamily(preferences.codeFontFamily)
    ? preferences.codeFontFamily
    : defaultOnlineCodiffPreferences.codeFontFamily,
});

const getInitialOnlineCodiffPreferences = (
  snapshotPreferences: Partial<OnlineCodiffPreferences>,
): OnlineCodiffPreferences => ({
  ...defaultOnlineCodiffPreferences,
  ...snapshotPreferences,
  ...(typeof window !== 'undefined' && window.matchMedia(mobileReviewMediaQuery).matches
    ? { diffStyle: 'unified' as const }
    : {}),
});

const parseOnlineCodiffPreferences = (
  rawPreferences: string,
  fallback: OnlineCodiffPreferences,
): OnlineCodiffPreferences => {
  try {
    const parsedPreferences = JSON.parse(rawPreferences) as unknown;
    if (!isRecord(parsedPreferences)) {
      return fallback;
    }
    return {
      codeFontFamily: isSafeCodeFontFamily(parsedPreferences.codeFontFamily)
        ? parsedPreferences.codeFontFamily
        : fallback.codeFontFamily,
      codeFontSize:
        typeof parsedPreferences.codeFontSize === 'number'
          ? clampCodeFontSize(parsedPreferences.codeFontSize)
          : fallback.codeFontSize,
      diffStyle:
        parsedPreferences.diffStyle === 'split' || parsedPreferences.diffStyle === 'unified'
          ? parsedPreferences.diffStyle
          : fallback.diffStyle,
      showWhitespace:
        typeof parsedPreferences.showWhitespace === 'boolean'
          ? parsedPreferences.showWhitespace
          : fallback.showWhitespace,
      theme:
        parsedPreferences.theme === 'dark' ||
        parsedPreferences.theme === 'light' ||
        parsedPreferences.theme === 'system'
          ? parsedPreferences.theme
          : fallback.theme,
      wordWrap:
        typeof parsedPreferences.wordWrap === 'boolean'
          ? parsedPreferences.wordWrap
          : fallback.wordWrap,
    };
  } catch {
    return fallback;
  }
};

const readOnlineCodiffPreferences = (
  snapshotPreferences: Partial<OnlineCodiffPreferences>,
): OnlineCodiffPreferences => {
  const fallback = getInitialOnlineCodiffPreferences(snapshotPreferences);
  if (typeof localStorage === 'undefined') {
    return fallback;
  }

  try {
    const storedPreferences = localStorage.getItem(onlineCodiffPreferencesKey);
    return storedPreferences ? parseOnlineCodiffPreferences(storedPreferences, fallback) : fallback;
  } catch {
    return fallback;
  }
};

const writeOnlineCodiffPreferences = (preferences: OnlineCodiffPreferences) => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(
      onlineCodiffPreferencesKey,
      JSON.stringify(sanitizeOnlineCodiffPreferences(preferences)),
    );
  } catch {
    // Ignore unavailable or full browser storage; preferences remain in memory.
  }
};

export const useOnlineCodiffPreferences = (
  snapshotPreferences: Partial<OnlineCodiffPreferences>,
) => {
  const [preferences, setPreferencesState] = useState(() =>
    readOnlineCodiffPreferences(snapshotPreferences),
  );
  const preferencesRef = useRef(preferences);
  const setPreferences = useCallback<Dispatch<SetStateAction<OnlineCodiffPreferences>>>(
    (update) => {
      const nextPreferences =
        typeof update === 'function' ? update(preferencesRef.current) : update;
      preferencesRef.current = nextPreferences;
      writeOnlineCodiffPreferences(nextPreferences);
      setPreferencesState(nextPreferences);
    },
    [],
  );

  useEffect(() => {
    writeOnlineCodiffPreferences(preferencesRef.current);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.defaultPrevented) {
        return;
      }

      const isIncrease =
        event.key === '+' ||
        event.key === '=' ||
        event.code === 'Equal' ||
        event.code === 'NumpadAdd';
      const isDecrease =
        event.key === '-' ||
        event.key === '_' ||
        event.code === 'Minus' ||
        event.code === 'NumpadSubtract';
      const isReset = event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0';

      if (!isIncrease && !isDecrease && !isReset) {
        return;
      }

      event.preventDefault();
      setPreferences((current) => ({
        ...current,
        codeFontSize: isReset
          ? CODE_FONT_SIZE_DEFAULT
          : clampCodeFontSize(current.codeFontSize + (isIncrease ? 1 : -1)),
      }));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setPreferences]);

  return [preferences, setPreferences] as const;
};

export const CodiffSettingsBar = ({
  preferences,
  setPreferences,
}: {
  preferences: OnlineCodiffPreferences;
  setPreferences: Dispatch<SetStateAction<OnlineCodiffPreferences>>;
}) => {
  const setPreference = <Key extends keyof OnlineCodiffPreferences>(
    key: Key,
    value: OnlineCodiffPreferences[Key],
  ) => {
    setPreferences((current) => ({ ...current, [key]: value }));
  };
  const adjustCodeFontSize = (delta: number) => {
    setPreferences((current) => ({
      ...current,
      codeFontSize: clampCodeFontSize(current.codeFontSize + delta),
    }));
  };

  return (
    <Dialog.Root>
      <div className="codiff-web-settings-bar">
        <Dialog.Trigger
          aria-label="Settings"
          render={
            <Button
              className="codiff-web-settings-trigger"
              size="icon"
              title="Settings"
              variant="outline"
            />
          }
        >
          <GearSix aria-hidden size={16} />
        </Dialog.Trigger>
      </div>
      <Dialog.Portal>
        <Dialog.Backdrop className="codiff-web-settings-backdrop" />
        <Dialog.Viewport className="codiff-web-settings-viewport">
          <Dialog.Popup className="codiff-web-settings-dialog">
            <div className="codiff-web-settings-header">
              <Dialog.Title className="codiff-web-settings-title">Settings</Dialog.Title>
              <Dialog.Close
                aria-label="Close settings"
                render={
                  <Button
                    className="codiff-web-settings-close"
                    size="icon"
                    title="Close"
                    variant="ghost"
                  />
                }
              >
                <X aria-hidden size={16} />
              </Dialog.Close>
            </div>
            <div className="codiff-web-settings-content">
              <fieldset className="codiff-web-settings-field">
                <legend>Appearance</legend>
                <div className="codiff-web-settings-segmented">
                  {(['system', 'light', 'dark'] as const).map((theme) => (
                    <button
                      aria-pressed={preferences.theme === theme}
                      key={theme}
                      onClick={() => setPreference('theme', theme)}
                      type="button"
                    >
                      {theme}
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset className="codiff-web-settings-field">
                <legend>Diffs</legend>
                <div className="codiff-web-settings-segmented">
                  {(['split', 'unified'] as const).map((diffStyle) => (
                    <button
                      aria-pressed={preferences.diffStyle === diffStyle}
                      key={diffStyle}
                      onClick={() => setPreference('diffStyle', diffStyle)}
                      type="button"
                    >
                      {diffStyle}
                    </button>
                  ))}
                </div>
                <label className="codiff-web-settings-row">
                  <span>
                    <strong>Word wrap</strong>
                    <small>Wrap long code and markdown lines.</small>
                  </span>
                  <input
                    checked={preferences.wordWrap}
                    className="pull-request-merge-input"
                    onChange={(event) => setPreference('wordWrap', event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span aria-hidden className="codiff-viewed-checkbox">
                    {preferences.wordWrap ? <Check size={11} weight="bold" /> : null}
                  </span>
                </label>
                <label className="codiff-web-settings-row">
                  <span>
                    <strong>Show whitespace</strong>
                    <small>Render spaces and tabs in diffs.</small>
                  </span>
                  <input
                    checked={preferences.showWhitespace}
                    className="pull-request-merge-input"
                    onChange={(event) =>
                      setPreference('showWhitespace', event.currentTarget.checked)
                    }
                    type="checkbox"
                  />
                  <span aria-hidden className="codiff-viewed-checkbox">
                    {preferences.showWhitespace ? <Check size={11} weight="bold" /> : null}
                  </span>
                </label>
              </fieldset>
              <fieldset className="codiff-web-settings-field">
                <legend>Code font</legend>
                <label className="codiff-web-settings-control">
                  <span>Family</span>
                  <input
                    className="codiff-web-settings-text-input"
                    onChange={(event) =>
                      setPreference(
                        'codeFontFamily',
                        event.currentTarget.value || defaultOnlineCodiffPreferences.codeFontFamily,
                      )
                    }
                    spellCheck={false}
                    value={preferences.codeFontFamily}
                  />
                </label>
                <div className="codiff-web-settings-control">
                  <span>Size</span>
                  <div className="codiff-web-settings-stepper">
                    <Button
                      aria-label="Decrease code font size"
                      disabled={preferences.codeFontSize <= CODE_FONT_SIZE_MIN}
                      onClick={() => adjustCodeFontSize(-1)}
                      size="icon"
                      title="Decrease code font size"
                      type="button"
                      variant="outline"
                    >
                      <Minus aria-hidden size={15} />
                    </Button>
                    <output>{preferences.codeFontSize}px</output>
                    <Button
                      aria-label="Increase code font size"
                      disabled={preferences.codeFontSize >= CODE_FONT_SIZE_MAX}
                      onClick={() => adjustCodeFontSize(1)}
                      size="icon"
                      title="Increase code font size"
                      type="button"
                      variant="outline"
                    >
                      <Plus aria-hidden size={15} />
                    </Button>
                    <Button
                      aria-label="Reset code font size"
                      onClick={() => setPreference('codeFontSize', CODE_FONT_SIZE_DEFAULT)}
                      size="icon"
                      title="Reset code font size"
                      type="button"
                      variant="ghost"
                    >
                      <ArrowCounterClockwise aria-hidden size={15} />
                    </Button>
                  </div>
                </div>
              </fieldset>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
