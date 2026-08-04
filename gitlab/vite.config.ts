import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    copy: [],
    deps: {
      alwaysBundle: ['@nkzw/codiff-core'],
      dts: { neverBundle: ['@nkzw/codiff-core'] },
    },
    dts: false,
  },
});
