import defaults from '../../config/defaults.json' with { type: 'json' };
import type { CodiffConfig } from './types.ts';

// TypeScript widens values imported from JSON, so it cannot know that
// "split" is a valid CodiffDiffStyle or "system" is a valid CodiffTheme.
// We keep defaults in JSON so Electron and the renderer share one source.
// If config gets deeper or more complex, replace this cast with runtime
// validation or a typed source that generates the CJS shape.
const defaultConfigTemplate = defaults as CodiffConfig;

export const createDefaultConfig = (): CodiffConfig => ({
  keymap: { ...defaultConfigTemplate.keymap },
  settings: { ...defaultConfigTemplate.settings },
});

export const defaultKeymap = defaultConfigTemplate.keymap;
export const defaultSettings = defaultConfigTemplate.settings;
