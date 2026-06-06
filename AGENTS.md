# Agent Instructions

- At the end of every code change, run `vp build` so the built files are refreshed for local testing.
- Run `vp check --fix` as the validation command after code changes, before `vp build`.
- Prefer Phosphor icons over Lucide icons for new UI. Use Lucide only when it is already the established local pattern for that specific control or when a Lucide icon is intentionally better suited, such as existing copy icons.
- When asked to update the Homebrew tap after a signed macOS build, use the signed zip from `out/make/zip/darwin/arm64/Codiff-darwin-arm64-<version>.zip`, make sure the matching `v<version>` GitHub Release asset exists and downloads from `https://github.com/nkzw-tech/codiff/releases/download/v<version>/Codiff-darwin-arm64-<version>.zip`, update `nkzw-tech/homebrew-tap` (`Casks/codiff.rb`) with the new `version` and SHA-256, then run `brew audit --cask nkzw-tech/tap/codiff` and `brew style --cask nkzw-tech/tap/codiff` through the tapped checkout before pushing.
- When you make changes to how the walkthrough works, you should consider updating the --walkthrough-guide which gives user-land agents info
