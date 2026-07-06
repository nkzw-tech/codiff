import { init as initGhostty, Terminal } from 'ghostty-web';
import { useEffect, useRef, useState } from 'react';
import {
  changeTypeLabel,
  type CommitFile,
  type CommitGroup,
  type CommitModel,
} from '../../../lib/narrative-walkthrough.ts';
import type {
  WalkthroughCommitMessageRequest,
  WalkthroughCommitMessageResult,
  WalkthroughCommitRequest,
  WalkthroughCommitResult,
} from '../../../types.ts';
import { ArrowsClockwise, Check, GitBranch, X } from './icons.tsx';
import { ChapterIcon, WalkthroughLineCount } from './parts.tsx';

export type CommitHandler = (request: WalkthroughCommitRequest) => Promise<WalkthroughCommitResult>;
export type CommitMessageHandler = (
  request: WalkthroughCommitMessageRequest,
) => Promise<WalkthroughCommitMessageResult>;
/** Subscribe to live commit output (pre-commit hook logs); returns unsubscribe. */
export type CommitOutputSubscriber = (callback: (chunk: string) => void) => () => void;

export type CommitDraftState = {
  commitBody: string;
  commitSelected: ReadonlySet<string>;
  commitSubject: string;
  setCommitBody: (value: string) => void;
  setCommitSubject: (value: string) => void;
  toggleCommitFile: (path: string) => void;
  toggleCommitGroup: (paths: ReadonlyArray<string>) => void;
};

type CheckState = 'on' | 'off' | 'partial';

// Cols must match the PTY spawned in electron/walkthrough-commit.cjs so hook
// output wraps where the PTY wrapped it.
const TERMINAL_COLS = 80;
const TERMINAL_ROWS = 12;

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
 * Read-only ghostty-web terminal that replays the streamed commit output, so
 * ANSI colors and cursor movement from pre-commit hooks render as they would
 * in a real shell.
 */
function CommitLogTerminal({ output }: { output: string }) {
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
    void initGhostty().then(() => {
      if (disposed) {
        return;
      }
      const style = getComputedStyle(container);
      instance = new Terminal({
        cols: TERMINAL_COLS,
        // Hook runners pipe their children, so some lines arrive with bare `\n`
        // and would stairstep without this.
        convertEol: true,
        disableStdin: true,
        fontFamily: style.fontFamily,
        fontSize: 12,
        rows: TERMINAL_ROWS,
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
    return () => {
      disposed = true;
      instance?.dispose();
      setTerminal(null);
    };
  }, []);

  useEffect(() => {
    // Output only grows within one commit attempt; each attempt remounts this
    // component (keyed by the parent), so a fresh terminal starts empty.
    if (!terminal || output.length <= writtenRef.current) {
      return;
    }
    terminal.write(output.slice(writtenRef.current));
    writtenRef.current = output.length;
  }, [terminal, output]);

  return <div className="wt-commit-log-term" ref={containerRef} />;
}

function CommitCheck({ state }: { state: CheckState }) {
  if (state === 'partial') {
    return (
      <span className="wt-check partial">
        <span className="wt-check-dash" />
      </span>
    );
  }
  return (
    <span className={`wt-check${state === 'on' ? ' on' : ''}`}>
      {state === 'on' ? <Check size={12} weight="bold" /> : null}
    </span>
  );
}

function ChangeTag({ file }: { file: CommitFile }) {
  if (!file.changeType) {
    return null;
  }
  return (
    <span className={`wt-ctag wt-ctag-${file.changeType}`}>{changeTypeLabel[file.changeType]}</span>
  );
}

function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf('/');
  if (cut === -1) {
    return <span className="wt-stage-file-path">{path}</span>;
  }
  return (
    <span className="wt-stage-file-path">
      <span className="dir">{path.slice(0, cut + 1)}</span>
      {path.slice(cut + 1)}
    </span>
  );
}

function StageFileRow({
  file,
  on,
  onToggle,
}: {
  file: CommitFile;
  on: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <button
      className={`wt-stage-file${on ? '' : ' off'}`}
      onClick={() => onToggle(file.path)}
      type="button"
    >
      <CommitCheck state={on ? 'on' : 'off'} />
      <span className="wt-stage-file-main">
        <PathLabel path={file.path} />
        {file.note ? <span className="wt-stage-file-note">{file.note}</span> : null}
      </span>
      <ChangeTag file={file} />
      <WalkthroughLineCount added={file.added} deleted={file.deleted} />
    </button>
  );
}

function StageGroupRow({
  group,
  onToggleFile,
  onToggleGroup,
  selected,
}: {
  group: CommitGroup;
  onToggleFile: (path: string) => void;
  onToggleGroup: (paths: ReadonlyArray<string>) => void;
  selected: ReadonlySet<string>;
}) {
  const paths = group.files.map((file) => file.path);
  const onCount = paths.filter((path) => selected.has(path)).length;
  const state: CheckState = onCount === 0 ? 'off' : onCount === paths.length ? 'on' : 'partial';
  return (
    <div className="wt-stage-group">
      <button className="wt-stage-group-head" onClick={() => onToggleGroup(paths)} type="button">
        <CommitCheck state={state} />
        <span className="wt-stage-group-icon">
          <ChapterIcon icon={group.icon} size={14} />
        </span>
        <span className="wt-stage-group-title">{group.title}</span>
        <span className="wt-stage-group-count">
          {onCount}/{paths.length}
        </span>
      </button>
      {group.files.map((file) => (
        <StageFileRow
          file={file}
          key={file.path}
          on={selected.has(file.path)}
          onToggle={onToggleFile}
        />
      ))}
    </div>
  );
}

function SubjectInput({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  const length = value.length;
  return (
    <div className="wt-commit-subject">
      <div className="wt-commit-subject-wrap">
        <input
          className="wt-commit-subject-field"
          onChange={(event) => onChange(event.target.value)}
          placeholder="Summarize the change in one line…"
          spellCheck={false}
          value={value}
        />
      </div>
      <div className="wt-commit-subject-foot">
        <span className={`wt-commit-count${length > 50 ? ' warn' : ''}`}>{length}/50</span>
      </div>
    </div>
  );
}

/**
 * Editable commit body. When the file selection is narrowed below the full set,
 * an "Update the message" action asks the agent to rewrite the prose for exactly
 * the selected files.
 */
function MessageDraft({
  canUpdate,
  flash,
  onChange,
  onUpdate,
  updateError,
  updating,
  value,
}: {
  canUpdate: boolean;
  flash: boolean;
  onChange: (value: string) => void;
  onUpdate: () => void;
  updateError: string | null;
  updating: boolean;
  value: string;
}) {
  return (
    <div className="wt-commit-msg-section">
      <span className="wt-commit-body-label">Summary</span>
      <div className="wt-commit-msg">
        {canUpdate ? (
          <div className="wt-commit-msg-head">
            <span className="wt-commit-msg-actions">
              <button
                className="wt-commit-update"
                disabled={updating}
                onClick={onUpdate}
                type="button"
              >
                <ArrowsClockwise size={14} />
                {updating ? 'Updating…' : 'Update the message'}
              </button>
            </span>
          </div>
        ) : null}
        <div className={`wt-commit-msg-body${flash ? ' flash' : ''}`}>
          <textarea
            className="wt-commit-msg-input"
            onChange={(event) => onChange(event.target.value)}
            placeholder="Describe the change in a paragraph or two…"
            spellCheck={false}
            value={value}
          />
        </div>
        {updateError ? <div className="wt-commit-msg-foot error">{updateError}</div> : null}
      </div>
    </div>
  );
}

export function CommitView({
  branch,
  draft,
  model,
  onCommit,
  onCommitOutput,
  onUpdateMessage,
}: {
  branch: string | null;
  draft: CommitDraftState;
  model: CommitModel;
  onCommit: CommitHandler;
  onCommitOutput?: CommitOutputSubscriber;
  onUpdateMessage: CommitMessageHandler;
}) {
  const selected = draft.commitSelected;
  const selectedFiles = model.files.filter((file) => selected.has(file.path));
  const totals = selectedFiles.reduce(
    (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
    { added: 0, deleted: 0 },
  );
  const subject = draft.commitSubject;
  const allSelected = selectedFiles.length === model.files.length;

  const [status, setStatus] = useState<'idle' | 'submitting'>('idle');
  const [result, setResult] = useState<WalkthroughCommitResult | null>(null);
  const [output, setOutput] = useState('');
  // Remounts the log terminal on each commit attempt so it starts empty.
  const [attempt, setAttempt] = useState(0);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [bodyFlash, setBodyFlash] = useState(false);

  const committed = result?.status === 'committed';
  const canCommit =
    status === 'idle' &&
    !committed &&
    !updating &&
    selectedFiles.length > 0 &&
    subject.trim().length > 0;
  const canUpdate = !allSelected && selectedFiles.length > 0 && !committed;

  const updateMessage = async () => {
    if (!canUpdate || updating) {
      return;
    }
    setUpdating(true);
    setUpdateError(null);
    const next = await onUpdateMessage({
      body: draft.commitBody,
      paths: selectedFiles.map((file) => file.path),
      subject: subject.trim(),
    });
    setUpdating(false);
    if (next.status === 'ready') {
      draft.setCommitBody(next.body);
      if (next.subject) {
        draft.setCommitSubject(next.subject);
      }
      setBodyFlash(true);
      window.setTimeout(() => setBodyFlash(false), 700);
    } else {
      setUpdateError(next.reason);
    }
  };

  const submit = async () => {
    if (!canCommit) {
      return;
    }
    setStatus('submitting');
    setResult(null);
    setOutput('');
    setAttempt((current) => current + 1);
    const unsubscribe = onCommitOutput?.((chunk) => setOutput((current) => current + chunk));
    try {
      const next = await onCommit({
        body: draft.commitBody.trim(),
        paths: selectedFiles.map((file) => file.path),
        subject: subject.trim(),
      });
      setResult(next);
    } finally {
      unsubscribe?.();
      setStatus('idle');
    }
  };

  const dismissFailure = () => {
    setResult((current) => (current?.status === 'failed' ? null : current));
    setOutput('');
  };

  const failed = result?.status === 'failed';
  const showLog = status === 'submitting' || (failed && output.length > 0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void submit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // https://github.com/react/react/issues/35499
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submit]);

  return (
    <div className="wt-commit">
      <div className="wt-commit-bar">
        <span className="wt-commit-bar-title">Commit</span>
        {branch ? (
          <span className="wt-commit-bar-branch">
            <GitBranch size={13} /> {branch}
          </span>
        ) : null}
        <span className="wt-commit-bar-meta">
          {selectedFiles.length} file{selectedFiles.length === 1 ? '' : 's'} ·{' '}
          <span className="added">+{totals.added}</span>{' '}
          <span className="deleted">−{totals.deleted}</span>
        </span>
      </div>
      <div className="wt-commit-scroll">
        <div className="wt-commit-stage">
          {committed ? (
            <div className="wt-commit-recap">
              <span className="wt-commit-recap-icon">
                <Check size={17} weight="bold" />
              </span>
              <span className="wt-commit-recap-text">
                <strong>
                  Committed {selectedFiles.length} file{selectedFiles.length === 1 ? '' : 's'}
                </strong>
                <span>
                  {result && result.status === 'committed' ? result.hash.slice(0, 10) : ''}
                  {branch ? ` · onto ${branch}` : ''}
                </span>
              </span>
            </div>
          ) : null}
          <SubjectInput onChange={draft.setCommitSubject} value={draft.commitSubject} />
          <MessageDraft
            canUpdate={canUpdate}
            flash={bodyFlash}
            onChange={draft.setCommitBody}
            onUpdate={updateMessage}
            updateError={updateError}
            updating={updating}
            value={draft.commitBody}
          />
          <div className="wt-stage-files">
            <div className="wt-stage-files-head">
              <span className="wt-stage-files-title">Files in this commit</span>
              <span className="wt-stage-files-sel">
                {selectedFiles.length} of {model.files.length} selected
              </span>
            </div>
            {model.groups.map((group) => (
              <StageGroupRow
                group={group}
                key={group.id}
                onToggleFile={draft.toggleCommitFile}
                onToggleGroup={draft.toggleCommitGroup}
                selected={selected}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="wt-commit-foot">
        {showLog ? (
          <div className={`wt-commit-log${failed ? ' failed' : ''}`}>
            <div className="wt-commit-log-head">
              <span className="wt-commit-log-title">
                {failed ? (
                  'Commit output'
                ) : (
                  <>
                    <span className="wt-commit-log-pulse" />
                    Committing…
                  </>
                )}
              </span>
              {failed ? (
                <button
                  aria-label="Dismiss commit error"
                  className="wt-commit-dismiss"
                  onClick={dismissFailure}
                  type="button"
                >
                  <X size={14} weight="bold" />
                </button>
              ) : null}
            </div>
            <CommitLogTerminal key={attempt} output={output} />
          </div>
        ) : null}
        <div className="wt-commit-foot-row">
          {result?.status === 'failed' ? (
            <span className="wt-commit-foot-error">
              <span className="wt-commit-error-text">
                {output.trim() ? 'The commit failed — see the output above.' : result.reason}
              </span>
              {!showLog ? (
                <button
                  aria-label="Dismiss commit error"
                  className="wt-commit-dismiss"
                  onClick={dismissFailure}
                  type="button"
                >
                  <X size={14} weight="bold" />
                </button>
              ) : null}
            </span>
          ) : null}
          <span className="wt-commit-foot-actions">
            <button
              className="codiff-open-button wt-commit-btn"
              disabled={!canCommit}
              onClick={submit}
              type="button"
            >
              <GitBranch size={16} />
              <span>
                {committed ? 'Committed' : status === 'submitting' ? 'Committing…' : 'Commit'}
              </span>
              {!allSelected && !committed ? (
                <span className="lc">
                  {selectedFiles.length} file{selectedFiles.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
