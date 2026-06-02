# Codiff

Codiff is a beautiful, minimal, local diff viewer for reviewing staged and unstaged Git changes before committing.

<img width="2824" height="1856" src="https://github.com/user-attachments/assets/b8cd9b57-cb7a-4d7f-8a61-9ef7f40fa6b8" />

## Why Codiff

- **Fast Local Reviews:** See changes in any Git repository to review code before committing.
- **LLM Walkthroughs:** Run `codiff -w` to ask Codex to give you a review order and more context.
- **Inline Review Comments:** Comment directly on changed lines and copy all review comments as Markdown for follow-ups.

## Download

Install with Homebrew:

```bash
brew install --cask nkzw-tech/tap/codiff
```

Download the latest Codiff app from [GitHub Releases](https://github.com/nkzw-tech/codiff/releases).

After installing the app, run `Codiff > Install Terminal Helper` to make the `codiff` command available in your shell.

## Command Line

```bash
codiff
```

Run it from any Git repository, or pass a path:

```bash
codiff /path/to/repository
```

Review a specific commit:

```bash
codiff a1b2c3d
```

Start with an LLM-generated walkthrough order:

```bash
codiff -w
codiff -w a1b2c3d
```

Show all available options:

```bash
codiff --help
```

Launching Codiff in multiple repositories opens a separate native window for each repository.

## Command Bar

Open the command bar with <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> on macOS, or
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> on other platforms. Type to filter commands, use
<kbd>Up</kbd>/<kbd>Down</kbd> to move through results, press <kbd>Enter</kbd> to run the selected
command, and press <kbd>Esc</kbd> to close it.

The command bar includes actions for common review workflows:

- Focus File Filter
- Find in Diffs
- Show File Tree, Show History, and Show Walkthrough
- Copy Review Comments
- Copy Review Comments and Close
- Toggle Viewed for the currently selected file
- Toggle Diff Layout, with the target layout action shown as the hint
- Open the currently selected file in your editor
- Toggle Sidebar
- Reload Window

## Configuration

Codiff reads configuration from `~/.codiff/codiff.jsonc`. Open `Codiff > Open Config File...` to
create the file with defaults and open it in your editor. The file supports JSONC comments and
trailing commas, includes a JSON schema reference for editor completion, and is watched while Codiff
is running so changes apply to open windows.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/nkzw-tech/codiff/main/src/config/codiff-config.schema.json",
  "settings": {
    "copyCommentsOnClose": false,
    "diffStyle": "split",
    "editorCommand": "",
    "lastRepositoryPath": "",
    "openAIModel": "gpt-5.3-codex-spark",
    "showWhitespace": false,
    "theme": "system",
    "wordWrap": false,
  },
  "keymap": {
    "commandBar": "Mod+Shift+p",
    "diffSearch": "Mod+f",
    "fileFilter": "Mod+p",
    "nextSearchMatch": "Enter",
    "openFile": "Mod+k",
    "prevSearchMatch": "Shift+Enter",
    "closeSearch": "Escape",
    "submitComment": "Mod+Enter",
    "discardComment": "Escape",
    "toggleSidebar": "Mod+b",
  },
}
```

Set `settings.editorCommand` to customize file opening. Use `{file}` for the selected file and
`{repo}` for the repository root, for example `"subl \"{repo}\" \"{file}\""`.

Choose `View > Split Diff` or `View > Unified Diff`, use Toggle Diff Layout in the command bar,
or set `settings.diffStyle` to `split` for side-by-side diffs or `unified` for unified diffs.
Choose `View > Word Wrap`, use Toggle Word Wrap in the command bar, or set `settings.wordWrap`
to `true` to wrap long diff lines.
Use `Mod` for <kbd>Cmd</kbd> on macOS and <kbd>Ctrl</kbd> on other platforms. Shortcut strings can
combine `Mod`, `Ctrl`, `Alt`, `Shift`, or `Meta` with a key, for example `Mod+Shift+p` or
`Alt+Enter`.

## Codex Walkthroughs

Codiff uses the local Codex CLI for walkthroughs and inline review assistance. Install Codex and
verify it is available before using `codiff -w`:

```bash
codex --version
```

Codiff looks for Codex on `PATH`, `/opt/homebrew/bin/codex`, and `/usr/local/bin/codex`. It does not
run your shell startup files to discover Codex. If Codex is installed somewhere else, launch Codiff
with an explicit path:

```bash
CODIFF_CODEX_PATH=/absolute/path/to/codex codiff -w
```

To seed a walkthrough with the Codex conversation that produced the change, choose
`Codiff > Install Codex Skill`, then invoke it from Codex:

```text
$codiff
```

The skill opens Codiff with `codiff -w --codex-session <id>`. Codiff then generates its normal diff
digest and runs the walkthrough prompt by ephemerally resuming that Codex session, so the
walkthrough sees the original conversation without a lossy summary handoff.

## Development

```bash
vp install
vp build
vpr codiff
```

For live development:

```bash
vpr dev
ELECTRON_RENDERER_URL=http://127.0.0.1:5173 vpr electron
```

Useful checks:

```bash
vp check
vp test
vp build
```
