import { getShortcutLabel } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';

type ShortcutDescriptor = {
  action: keyof CodiffKeymap;
  label: string;
};

type ShortcutGroup = {
  shortcuts: ReadonlyArray<ShortcutDescriptor>;
  title: string;
};

const SHORTCUT_GROUPS: ReadonlyArray<ShortcutGroup> = [
  {
    shortcuts: [
      { action: 'commandBar', label: 'Command bar' },
      { action: 'fileFilter', label: 'Filter files' },
      { action: 'nextHunk', label: 'Next hunk / comment' },
      { action: 'prevHunk', label: 'Previous hunk / comment' },
      { action: 'toggleSidebar', label: 'Toggle sidebar' },
      { action: 'toggleWordWrap', label: 'Toggle word wrap' },
      { action: 'openFile', label: 'Open file in editor' },
      { action: 'shortcutsHelp', label: 'Show this help' },
    ],
    title: 'Navigation',
  },
  {
    shortcuts: [
      { action: 'diffSearch', label: 'Find in diffs' },
      { action: 'nextSearchMatch', label: 'Next match' },
      { action: 'prevSearchMatch', label: 'Previous match' },
      { action: 'closeSearch', label: 'Close search' },
    ],
    title: 'Search',
  },
  {
    shortcuts: [
      { action: 'submitComment', label: 'Submit comment' },
      { action: 'discardComment', label: 'Discard comment' },
    ],
    title: 'Comments',
  },
];

export function KeyboardShortcutsHelp({
  keymap,
  visible,
}: {
  keymap: CodiffKeymap;
  visible: boolean;
}) {
  if (!visible) {
    return null;
  }

  return (
    <div className="shortcuts-help-overlay">
      <div className="shortcuts-help">
        <div className="shortcuts-help-header">
          <span className="shortcuts-help-title">Keyboard Shortcuts</span>
          <span className="shortcuts-help-hint">Release to dismiss</span>
        </div>
        <div className="shortcuts-help-grid">
          {SHORTCUT_GROUPS.map((group) => (
            <section className="shortcuts-help-group" key={group.title}>
              <h2 className="shortcuts-help-group-title">{group.title}</h2>
              <ul className="shortcuts-help-list">
                {group.shortcuts.map((shortcut) => (
                  <li className="shortcuts-help-row" key={shortcut.action}>
                    <span className="shortcuts-help-label">{shortcut.label}</span>
                    <span className="shortcuts-help-keys">
                      {getShortcutLabel(keymap, shortcut.action)
                        .split('+')
                        .map((key, index) => (
                          <kbd className="shortcuts-help-key" key={`${shortcut.action}-${index}`}>
                            {key}
                          </kbd>
                        ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
