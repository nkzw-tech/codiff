# Codiff

Codiff is a beautiful, minimal, local diff viewer for reviewing Git changes and committing them.

<img width="48%" src="https://github.com/user-attachments/assets/9801587d-5879-461a-b375-9fbfa3c5f25d" />
<img width="48%" src="https://github.com/user-attachments/assets/8b92902b-1112-4553-ba59-74e84a61ca7d" />

## Why Codiff

- **Fast Local Reviews:** Review and commit changes in any Git repository.
- **LLM Walkthroughs:** Run `codiff -w` to generate an optimized commit walkthrough.
- **Inline Review Comments:** Comment directly on GitHub pull requests and GitLab merge requests, or copy review comments as Markdown for follow-ups.

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

Review the current branch against a target branch:

```bash
codiff main
```

Review a GitHub pull request or GitLab merge request using the current repository remote:

```bash
codiff pr 75
codiff mr 23
```

Full GitHub and GitLab review URLs are also supported. GitLab hosts and nested project paths are
derived from the URL or local Git remote and authenticated through `glab`; Codiff does not require
instance-specific configuration.

Start with an LLM-generated narrative walkthrough. When generating a walkthrough without an
explicit target, Codiff uses local changes when present and falls back to `HEAD` when the working
tree is clean:

```bash
codiff -w
codiff -w a1b2c3d
```

When walkthrough sharing is available for your Git identity, generate and upload the same
walkthrough without opening Codiff. The same default applies to generated walkthroughs, and the
command prints the final URL:

```bash
codiff --share
codiff --share HEAD
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

Set `settings.showWhitespace` to `true` to show whitespace-only changes in diffs and file line
counts; when it is `false`, Codiff hides those changes from the working-tree review state.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/nkzw-tech/codiff/main/core/config/codiff-config.schema.json",
  "settings": {
    "agentBackend": "codex",
    "claudeModel": "claude-sonnet-4-6",
    "codeFontFamily": "",
    "codeFontSize": 13,
    "copyCommentsOnClose": false,
    "diffStyle": "split",
    "editorCommand": "",
    "lastRepositoryPath": "",
    "openAIModel": "gpt-5.3-codex-spark",
    "opencodeModel": "opencode-default",
    "showWhitespace": false,
    "theme": "system",
    "walkthroughPrompt": "",
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

Choose `View > Diff > Split` or `View > Diff > Unified`, use Toggle Diff Layout in the command bar,
or set `settings.diffStyle` to `split` for side-by-side diffs or `unified` for unified diffs.
Choose `View > Diff > Word Wrap`, use Toggle Word Wrap in the command bar, or set
`settings.wordWrap` to `true` to wrap long diff lines.
Choose `View > Diff > Font Size`, use the code font size commands in the command bar, or use
<kbd>Cmd/Ctrl</kbd>+<kbd>+</kbd>, <kbd>Cmd/Ctrl</kbd>+<kbd>-</kbd>, and
<kbd>Cmd/Ctrl</kbd>+<kbd>0</kbd> to change only diff and code rendering font size.
Set `settings.codeFontFamily` manually to an installed CSS font family name, for example
`"JetBrains Mono"` or `"SF Mono"`. Leave it empty to use Codiff's bundled mono stack.
Use `Mod` for <kbd>Cmd</kbd> on macOS and <kbd>Ctrl</kbd> on other platforms. Shortcut strings can
combine `Mod`, `Ctrl`, `Alt`, `Shift`, or `Meta` with a key, for example `Mod+Shift+p` or
`Alt+Enter`.

## Walkthroughs

Codiff uses a local agent CLI for walkthroughs and inline review assistance. On the first launch
without an existing config file, it selects the first installed CLI in this order: Codex, Claude
Code, OpenCode, then Pi. This checks executable presence only and persists the selection. If none
are installed, Codiff keeps Codex as the default. After that, select a backend with the
`settings.agentBackend` config value (or the `--agent` flag for a single launch) and the `Agent`
application menu:

- `codex` (default) — the OpenAI Codex CLI, configured with `settings.openAIModel`.
- `claude` — the [Claude Code](https://claude.com/claude-code) CLI, configured with `settings.claudeModel`.
- `opencode` — the [OpenCode](https://opencode.ai/) CLI, configured with
  `settings.opencodeModel`.
- `pi` — the Pi CLI, using its configured default model.

Install the backend you want and verify it is available before using `codiff -w`:

```bash
codex --version
claude --version
opencode --version
pi --version
```

Codiff looks for the CLI on `PATH` and the usual install locations. On macOS, it also recognizes
the CLI embedded in `/Applications/Codex.app` or `~/Applications/Codex.app`. It does not run your
shell startup files to discover CLIs. If a CLI is installed somewhere else, launch Codiff with an
explicit path:

```bash
CODIFF_CODEX_PATH=/absolute/path/to/codex codiff -w
CODIFF_CLAUDE_PATH=/absolute/path/to/claude codiff --agent claude -w
CODIFF_OPENCODE_PATH=/absolute/path/to/opencode codiff --agent opencode -w
CODIFF_PI_PATH=/absolute/path/to/pi codiff --agent pi -w
```

Claude Code rides your existing `claude` login (subscription or `ANTHROPIC_API_KEY`); run `claude`
once and complete `/login` if you have not already.

OpenCode keeps its own configured model when `settings.opencodeModel` is `opencode-default`.
Choose another model from the application `Model` menu, or set a provider-qualified id such as
`anthropic/claude-sonnet-4-6`, `openai/gpt-5.5`, or another model available to your OpenCode
account. When Codiff launches OpenCode for walkthroughs or review assistance and an explicit model
is unavailable, it retries with OpenCode's configured default and persists that fallback. The
managed `/codiff` command runs directly in OpenCode, so OpenCode reports access errors for its
selected model; choose `opencode-default` when portability is more important than pinning.

Set `settings.walkthroughPrompt` to add custom instructions to generated walkthrough prompts. Use it
to request a specific language, tone, or level of detail while Codiff keeps its walkthrough guide,
hunk ids, review-order constraints, and JSON schema in place.

To drive Codiff from your agent, install its integration from the application menu under
`Install Skill`, then choose Codex, Claude Code, Pi, or OpenCode. Codiff updates keep the installed
skill current. The OpenCode integration also installs a managed `/codiff` command that uses
`settings.opencodeModel`; choosing `opencode-default` leaves the command unpinned. Invoke it from
the agent:

```text
$codiff       /codiff        # author a narrative walkthrough and open Codiff
```

In OpenCode, `/codiff` uses the model selected in Codiff while `$codiff` runs as part of the
current session and therefore uses that session's active model.

`codiff` asks Codiff for the current authoring guide (`codiff --walkthrough-guide`), writes a
narrative walkthrough JSON to a temporary file, and opens Codiff on it with `--walkthrough-file`
plus the current session id. Because the guidance lives in Codiff, the installed skill stays a thin
shim while the walkthrough sees the original conversation context without a lossy summary handoff.

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

## Contributing

Found an issue, or want to improve something? Open a PR.
