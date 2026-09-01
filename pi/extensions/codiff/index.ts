import { realpath } from 'node:fs/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAgentFeedbackBridge } from '../../../bin/agent-feedback-bridge.mjs';

const resolveGitRoot = async (pi: ExtensionAPI, cwd: string): Promise<string> => {
  const result = await pi.exec('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    timeout: 5000,
  });
  if (result.code !== 0 || result.stdout.trim() === '') {
    throw new Error('Codiff could not resolve the Pi session repository.');
  }
  const root = result.stdout.trim();
  return realpath(root).catch(() => root);
};

export default function codiffExtension(pi: ExtensionAPI): void {
  let closeBridge: (() => Promise<void>) | undefined;

  pi.on('session_start', async (_event, ctx) => {
    const close = closeBridge;
    closeBridge = undefined;
    await close?.();
    const repositoryRoot = await resolveGitRoot(pi, ctx.sessionManager.getCwd());
    const bridge = await createAgentFeedbackBridge({
      backend: 'pi',
      deliver: async ({ deliveryId, message }) => {
        if (ctx.isIdle()) {
          pi.sendUserMessage(message);
        } else {
          pi.sendUserMessage(message, { deliverAs: 'followUp' });
        }
        return { assurance: 'dispatch-started', deliveryId, status: 'accepted' };
      },
      getIdentity: () => ({
        repositoryRoot,
        sessionId: ctx.sessionManager.getSessionId(),
      }),
    });
    closeBridge = () => bridge.close();
  });

  pi.on('session_shutdown', async () => {
    const close = closeBridge;
    closeBridge = undefined;
    await close?.();
  });
}
