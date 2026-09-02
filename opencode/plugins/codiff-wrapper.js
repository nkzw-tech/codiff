// codiff-managed-opencode-plugin:v1
import { CodiffPlugin as PackagedCodiffPlugin } from '{{CODIFF_OPENCODE_PLUGIN_URL}}';

export const CodiffPlugin = (input) =>
  PackagedCodiffPlugin({ ...input, worktree: input.directory });
