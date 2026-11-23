import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { getAgent } = require('../agent.cjs') as {
  getAgent: (id: 'codex' | 'pi') => import('../agent.cjs').Agent;
};
const { buildAgentModelMenu } = require('../agent-model-menu.cjs') as {
  buildAgentModelMenu: (options: {
    agent: import('../agent.cjs').Agent;
    onRetryPiModelDiscovery?: () => void;
    onSelectModel: (model: string) => void;
    selectedModel: string;
  }) => import('electron').MenuItemConstructorOptions[];
};

test('Pi model menu exposes a retry action that starts discovery', () => {
  const retryDiscovery = vi.fn();
  const items = buildAgentModelMenu({
    agent: getAgent('pi'),
    onRetryPiModelDiscovery: retryDiscovery,
    onSelectModel: vi.fn(),
    selectedModel: 'pi-default',
  });
  const retryItem = items.find((item) => item.label === 'Retry model discovery');

  expect(retryItem?.click).toBeTypeOf('function');
  retryItem?.click?.({} as never, undefined, {} as never);
  expect(retryDiscovery).toHaveBeenCalledOnce();
});
