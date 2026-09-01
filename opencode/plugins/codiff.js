import { clearTimeout, setTimeout } from 'node:timers';
import { createAgentFeedbackBridge } from '../../bin/agent-feedback-bridge.mjs';

const MESSAGE_TIMEOUT_MS = 10_000;

const createMessageWaiter = (waiters, messageID, sessionID) => {
  let rejectWaiter;
  let resolveWaiter;
  const promise = new Promise((resolve, reject) => {
    rejectWaiter = reject;
    resolveWaiter = resolve;
  });
  // A waiter can be rejected while promptAsync is still pending.
  void promise.catch(() => {});
  const clear = () => {
    clearTimeout(timer);
    waiters.delete(messageID);
  };
  const timer = setTimeout(() => {
    clear();
    rejectWaiter(new Error('Timed out waiting for OpenCode to create the feedback message.'));
  }, MESSAGE_TIMEOUT_MS);
  const waiter = {
    cancel: clear,
    reject: (error) => {
      clear();
      rejectWaiter(error);
    },
    resolve: () => {
      clear();
      resolveWaiter();
    },
    sessionID,
  };
  waiters.set(messageID, waiter);
  return { promise, waiter };
};

export const CodiffPlugin = async ({ client, worktree }) => {
  const sessions = new Map();
  const sessionCreations = new Map();
  const messageWaiters = new Map();
  let disposed = false;

  const send = async (item) => {
    const messageID = `msg_codiff_${item.deliveryId.replaceAll('-', '')}`;
    const { promise: observed, waiter } = createMessageWaiter(
      messageWaiters,
      messageID,
      item.sessionId,
    );
    let result;
    try {
      result = await client.session.promptAsync({
        body: { messageID, parts: [{ text: item.message, type: 'text' }] },
        path: { id: item.sessionId },
      });
    } catch (error) {
      waiter.cancel();
      throw error;
    }
    if (result.error || result.response?.status !== 204) {
      waiter.cancel();
      throw new Error('OpenCode rejected the asynchronous prompt.');
    }
    await observed;
  };

  const ensureSession = (sessionID) => {
    if (disposed) {
      return Promise.resolve(undefined);
    }
    const current = sessions.get(sessionID);
    if (current) {
      return Promise.resolve(current);
    }
    const pending = sessionCreations.get(sessionID);
    if (pending) {
      return pending;
    }

    const state = {
      bridge: null,
      busy: false,
      deliveries: new Map(),
      draining: false,
      inFlight: new Map(),
      queue: [],
    };
    const creation = (async () => {
      state.bridge = await createAgentFeedbackBridge({
        backend: 'opencode',
        deliver: (item) => {
          const previous = state.deliveries.get(item.deliveryId);
          if (previous) {
            return Promise.resolve({ ...previous, status: 'already-accepted' });
          }
          const pending = state.inFlight.get(item.deliveryId);
          if (pending) {
            return pending;
          }

          const operation = (async () => {
            const statuses = await client.session.status();
            state.busy = statuses.data?.[sessionID]?.type === 'busy';
            if (state.busy || state.draining || state.queue.length > 0) {
              const receipt = {
                assurance: 'bridge-queue',
                deliveryId: item.deliveryId,
                status: 'queued',
              };
              state.queue.push(item);
              state.deliveries.set(item.deliveryId, receipt);
              return receipt;
            }

            await send(item);
            const receipt = {
              assurance: 'message-created',
              deliveryId: item.deliveryId,
              status: 'accepted',
            };
            state.deliveries.set(item.deliveryId, receipt);
            return receipt;
          })().finally(() => state.inFlight.delete(item.deliveryId));
          state.inFlight.set(item.deliveryId, operation);
          return operation;
        },
        getIdentity: () => ({ repositoryRoot: worktree, sessionId: sessionID }),
      });
      if (disposed) {
        await state.bridge.close();
        return undefined;
      }
      sessions.set(sessionID, state);
      return state;
    })().finally(() => sessionCreations.delete(sessionID));
    sessionCreations.set(sessionID, creation);
    return creation;
  };

  const drainOne = async (sessionID) => {
    const state = sessions.get(sessionID);
    if (!state || state.draining) {
      return;
    }
    const item = state.queue.shift();
    if (!item) {
      return;
    }
    state.draining = true;
    try {
      await send(item);
    } catch {
      // The bridge already acknowledged queued insertion; event hooks must not reject.
    } finally {
      state.draining = false;
    }
  };

  return {
    'chat.message': async ({ sessionID }, _output) => {
      await ensureSession(sessionID);
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const error = new Error('OpenCode feedback plugin was disposed.');
      for (const waiter of messageWaiters.values()) {
        waiter.reject(error);
      }
      await Promise.allSettled(sessionCreations.values());
      await Promise.all([...sessions.values()].map(({ bridge }) => bridge.close()));
      sessions.clear();
    },
    event: async ({ event }) => {
      if (disposed) {
        return;
      }
      if (event.type === 'message.updated') {
        const info = event.properties.info;
        const waiter = messageWaiters.get(info.id);
        if (info.role === 'user' && waiter?.sessionID === info.sessionID) {
          waiter.resolve();
        }
        return;
      }

      const { sessionID } = event.properties;
      const state = sessions.get(sessionID);
      if (!state) {
        return;
      }
      if (event.type === 'session.status') {
        state.busy = event.properties.status.type !== 'idle';
      }
      if (event.type === 'session.idle') {
        state.busy = false;
        await drainOne(sessionID);
      }
    },
  };
};
