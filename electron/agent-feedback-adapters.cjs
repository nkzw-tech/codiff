// @ts-check

const createAgentFeedbackAdapterRegistry = () => {
  const adapters = new Map();
  return {
    /** @param {import('../core/types.ts').AgentFeedbackDeliveryRequest} request */
    deliver(request) {
      const adapter = adapters.get(request.backend);
      if (!adapter) {
        throw new Error(`The ${request.backend} feedback adapter is unavailable.`);
      }
      return adapter.deliver(request);
    },
    /** @param {{backend: import('../core/types.ts').AgentBackend; repositoryRoot: string; sessionId: string}} identity */
    probe(identity) {
      const adapter = adapters.get(identity.backend);
      return adapter
        ? adapter.probe(identity)
        : Promise.resolve({
            available: false,
            reason: `The ${identity.backend} feedback adapter is unavailable.`,
          });
    },
    /**
     * @param {import('../core/types.ts').AgentBackend} backend
     * @param {{deliver: (request: import('../core/types.ts').AgentFeedbackDeliveryRequest) => Promise<import('../core/types.ts').AgentFeedbackDeliveryResponse>; probe: (identity: {backend: import('../core/types.ts').AgentBackend; repositoryRoot: string; sessionId: string}) => Promise<{available: boolean; reason?: string}>}} adapter
     */
    register(backend, adapter) {
      adapters.set(backend, adapter);
    },
  };
};

module.exports = { createAgentFeedbackAdapterRegistry };
