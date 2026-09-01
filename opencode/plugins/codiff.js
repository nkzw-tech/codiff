import { createHash } from 'node:crypto';
import { stderr } from 'node:process';
import { createAgentFeedbackBridge } from '../../bin/agent-feedback-bridge.mjs';

const AMBIGUOUS_LIMIT = 1000;
const MAX_PROMPT_ATTEMPTS = 3;
const MESSAGE_TIMEOUT_MS = 10_000;
const AMBIGUOUS_DIAGNOSTIC =
  'Codiff OpenCode feedback delivery became ambiguous after prompt acceptance.\n';
const EXHAUSTED_DIAGNOSTIC =
  'Codiff OpenCode feedback delivery exhausted pre-acceptance retries.\n';

const disposedError = () => new Error('OpenCode feedback plugin was disposed.');
const messageIDFor = (sessionID, deliveryID) => {
  const hash = createHash('sha256')
    .update(`${sessionID.length}:${sessionID}${deliveryID.length}:${deliveryID}`)
    .digest('hex');
  return `msg_codiff_${hash}`;
};
const waiterKey = (sessionID, messageID) => `${sessionID.length}:${sessionID}${messageID}`;

const writeDiagnostic = (message) => {
  try {
    stderr.write(message);
  } catch {
    // Diagnostics must not affect plugin dispatch.
  }
};

const queueReceipt = (item) => ({
  assurance: 'bridge-queue',
  deliveryId: item.deliveryId,
  status: 'queued',
});

const serialize = (state, operation) => {
  const result = state.dispatcher.then(operation, operation);
  state.dispatcher = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const track = (state, operation) => {
  state.operations.add(operation);
  void operation.finally(() => state.operations.delete(operation)).catch(() => {});
  return operation;
};

const createMessageWaiter = (waiters, messageID, sessionID) => {
  let rejectWaiter;
  let resolveWaiter;
  const key = waiterKey(sessionID, messageID);
  const promise = new Promise((resolve, reject) => {
    rejectWaiter = reject;
    resolveWaiter = resolve;
  });
  // Disposal can reject a waiter while promptAsync is still pending.
  void promise.catch(() => {});
  const clear = () => {
    globalThis.clearTimeout(timer);
    waiters.delete(key);
  };
  const timer = globalThis.setTimeout(() => {
    clear();
    const error = new Error('Timed out waiting for OpenCode to create the feedback message.');
    error.code = 'OPENCODE_MESSAGE_TIMEOUT';
    rejectWaiter(error);
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
  waiters.set(key, waiter);
  return { promise, waiter };
};

export const CodiffPlugin = async ({ client, worktree }) => {
  const sessions = new Map();
  const sessionCreations = new Map();
  const messageWaiters = new Map();
  let disposed = false;

  const statusIsIdle = async (sessionID) => {
    try {
      const result = await client.session.status();
      if (!result || result.error) {
        return false;
      }
      const statuses = result.data;
      if (!statuses || typeof statuses !== 'object' || !Object.hasOwn(statuses, sessionID)) {
        return true;
      }
      return statuses[sessionID]?.type === 'idle';
    } catch {
      return false;
    }
  };

  const retainAmbiguous = (state, deliveryID) => {
    state.ambiguous.set(deliveryID, true);
    if (state.ambiguous.size > AMBIGUOUS_LIMIT) {
      state.ambiguous.delete(state.ambiguous.keys().next().value);
    }
  };

  const retainForRetry = (state, entry) => {
    state.active = null;
    entry.attempts++;
    if (entry.attempts < MAX_PROMPT_ATTEMPTS) {
      state.queue.unshift(entry);
      return queueReceipt(entry.item);
    }
    writeDiagnostic(EXHAUSTED_DIAGNOSTIC);
    throw new Error('OpenCode rejected the feedback prompt after bounded retries.');
  };

  const markAmbiguous = (state, entry, submissionGeneration) => {
    state.active = null;
    state.ambiguityBarrierGeneration = submissionGeneration;
    retainAmbiguous(state, entry.item.deliveryId);
    writeDiagnostic(AMBIGUOUS_DIAGNOSTIC);
    if (state.idleGeneration > submissionGeneration) {
      void drainOne(state, state.idleGeneration).catch(() => {});
    }
  };

  const rejectAmbiguous = (state, entry, submissionGeneration) => {
    markAmbiguous(state, entry, submissionGeneration);
    throw new Error('OpenCode feedback delivery is ambiguous and will not be retried.');
  };

  const accept = async (state, entry) => {
    if (disposed) {
      throw disposedError();
    }
    state.active = entry;
    const idle = await statusIsIdle(entry.item.sessionId);
    if (disposed) {
      state.active = null;
      throw disposedError();
    }
    if (!idle) {
      state.active = null;
      state.queue.unshift(entry);
      return { receipt: queueReceipt(entry.item) };
    }

    const messageID = messageIDFor(entry.item.sessionId, entry.item.deliveryId);
    const { promise: observed, waiter } = createMessageWaiter(
      messageWaiters,
      messageID,
      entry.item.sessionId,
    );
    if (disposed) {
      state.active = null;
      waiter.reject(disposedError());
      throw disposedError();
    }

    const submissionGeneration = state.idleGeneration;
    let result;
    try {
      result = await client.session.promptAsync({
        body: { messageID, parts: [{ text: entry.item.message, type: 'text' }] },
        path: { id: entry.item.sessionId },
      });
    } catch {
      waiter.cancel();
      if (disposed) {
        state.active = null;
        throw disposedError();
      }
      return rejectAmbiguous(state, entry, submissionGeneration);
    }
    if (disposed) {
      state.active = null;
      waiter.reject(disposedError());
      throw disposedError();
    }
    const status = result?.response?.status;
    if (typeof status === 'number' && status !== 204) {
      waiter.cancel();
      return { receipt: retainForRetry(state, entry) };
    }
    if (status !== 204) {
      waiter.cancel();
      return rejectAmbiguous(state, entry, submissionGeneration);
    }
    return { entry, observed, submissionGeneration };
  };

  const complete = async (state, decision) => {
    if (decision.receipt) {
      return decision.receipt;
    }
    try {
      await decision.observed;
      if (disposed) {
        throw disposedError();
      }
      return {
        assurance: 'message-created',
        deliveryId: decision.entry.item.deliveryId,
        status: 'accepted',
      };
    } catch (error) {
      if (error?.code === 'OPENCODE_MESSAGE_TIMEOUT') {
        markAmbiguous(state, decision.entry, decision.submissionGeneration);
      }
      throw error;
    } finally {
      state.active = null;
    }
  };

  const dispatchDelivery = (state, item) => {
    if (disposed) {
      return Promise.reject(disposedError());
    }
    if (state.ambiguous.has(item.deliveryId)) {
      return Promise.reject(
        new Error('OpenCode feedback delivery is ambiguous and will not be retried.'),
      );
    }
    const pending = state.inFlight.get(item.deliveryId);
    if (pending) {
      return pending;
    }

    const entry = { attempts: 0, item };
    const operation = track(
      state,
      (async () => {
        const decision = await serialize(state, () => {
          if (disposed) {
            throw disposedError();
          }
          if (state.active || state.ambiguityBarrierGeneration !== null || state.queue.length > 0) {
            state.queue.push(entry);
            return { receipt: queueReceipt(item) };
          }
          return accept(state, entry);
        });
        return complete(state, decision);
      })(),
    );
    state.inFlight.set(item.deliveryId, operation);
    void operation.finally(() => state.inFlight.delete(item.deliveryId)).catch(() => {});
    return operation;
  };

  const drainOne = (state, idleGeneration) =>
    track(
      state,
      (async () => {
        const decision = await serialize(state, () => {
          if (disposed || state.active || idleGeneration <= state.consumedIdleGeneration) {
            return undefined;
          }
          if (
            state.ambiguityBarrierGeneration !== null &&
            idleGeneration <= state.ambiguityBarrierGeneration
          ) {
            return undefined;
          }
          state.consumedIdleGeneration = idleGeneration;
          state.ambiguityBarrierGeneration = null;
          const entry = state.queue.shift();
          return entry ? accept(state, entry) : undefined;
        });
        if (decision) {
          await complete(state, decision);
        }
      })(),
    );

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
      active: null,
      ambiguityBarrierGeneration: null,
      ambiguous: new Map(),
      bridge: null,
      consumedIdleGeneration: 0,
      dispatcher: Promise.resolve(),
      idleGeneration: 0,
      inFlight: new Map(),
      operations: new Set(),
      queue: [],
    };
    const creation = (async () => {
      state.bridge = await createAgentFeedbackBridge({
        backend: 'opencode',
        deliver: (item) => dispatchDelivery(state, item),
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

  return {
    'chat.message': async ({ sessionID }, _output) => {
      await ensureSession(sessionID);
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const error = disposedError();
      for (const waiter of messageWaiters.values()) {
        waiter.reject(error);
      }
      await Promise.allSettled(sessionCreations.values());
      await Promise.allSettled([...sessions.values()].flatMap(({ operations }) => [...operations]));
      await Promise.all([...sessions.values()].map(({ bridge }) => bridge.close()));
      sessions.clear();
    },
    event: async ({ event }) => {
      if (disposed) {
        return;
      }
      if (event.type === 'message.updated') {
        const info = event.properties.info;
        const waiter = messageWaiters.get(waiterKey(info.sessionID, info.id));
        if (info.role === 'user' && waiter?.sessionID === info.sessionID) {
          waiter.resolve();
        }
        return;
      }

      const state = sessions.get(event.properties.sessionID);
      if (event.type === 'session.idle' && state) {
        state.idleGeneration++;
        if (state.active) {
          return;
        }
        await drainOne(state, state.idleGeneration).catch(() => {});
      }
    },
  };
};
