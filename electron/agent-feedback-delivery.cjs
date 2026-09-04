// @ts-check

const { isDeepStrictEqual } = require('node:util');

const assurances = {
  claude: new Set(['transport-write']),
  codex: new Set(['queue-command']),
  opencode: new Set(['bridge-queue', 'message-created']),
  pi: new Set(['dispatch-started']),
};

/** @param {unknown} value */
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/** @param {unknown} value */
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

/** @param {unknown} value */
const isSide = (value) => value === 'additions' || value === 'deletions';

/** @param {unknown} value @param {string} field */
const requireString = (value, field) => {
  if (!isNonEmptyString(value)) {
    throw new Error(`Agent review feedback comment ${field} must be a non-empty string.`);
  }
};

/** @param {unknown} value @param {string} field */
const requirePositiveInteger = (value, field) => {
  if (!isPositiveInteger(value)) {
    throw new Error(`Agent review feedback comment ${field} must be a positive integer.`);
  }
};

/** @param {unknown} value */
const validateComment = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent review feedback comment must be an object.');
  }
  const comment = /** @type {Record<string, unknown>} */ (value);
  if (comment.anchor !== 'file' && comment.anchor !== 'line') {
    throw new Error('Agent review feedback comment anchor must be file or line.');
  }
  requireString(comment.body, 'body');
  if (comment.body !== comment.body.trim()) {
    throw new Error('Agent review feedback comment bodies must be trimmed.');
  }
  requireString(comment.context, 'context');
  requireString(comment.filePath, 'filePath');
  requireString(comment.sectionId, 'sectionId');
  requirePositiveInteger(comment.order, 'order');

  if (comment.anchor === 'file') {
    if (
      comment.lineNumber !== undefined ||
      comment.side !== undefined ||
      comment.startLineNumber !== undefined ||
      comment.startSide !== undefined
    ) {
      throw new Error('Agent review feedback file anchor must not include line fields.');
    }
    return;
  }

  requirePositiveInteger(comment.lineNumber, 'lineNumber');
  if (!isSide(comment.side)) {
    throw new Error('Agent review feedback comment side must be additions or deletions.');
  }
  if (comment.startLineNumber !== undefined) {
    requirePositiveInteger(comment.startLineNumber, 'startLineNumber');
  }
  if (comment.startSide !== undefined && !isSide(comment.startSide)) {
    throw new Error('Agent review feedback comment startSide must be additions or deletions.');
  }
  if (comment.startSide !== undefined && comment.startLineNumber === undefined) {
    throw new Error('Agent review feedback comment startSide requires startLineNumber.');
  }
};

/** @param {unknown} value */
const validateReviewSource = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent review feedback repository source must be an object.');
  }
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @param {string} field */
  const requireSourceString = (field) => {
    if (!isNonEmptyString(source[field])) {
      throw new Error(`Agent review feedback repository source ${field} must not be empty.`);
    }
  };
  switch (source.type) {
    case 'working-tree':
      return;
    case 'branch':
    case 'commit':
      requireSourceString('ref');
      return;
    case 'branch-diff':
      requireSourceString('baseRef');
      requireSourceString('headRef');
      requireSourceString('ref');
      return;
    case 'branch-working-tree':
      requireSourceString('ref');
      if (source.baseRef !== undefined) requireSourceString('baseRef');
      if (source.headRef !== undefined) requireSourceString('headRef');
      return;
    case 'range':
      requireSourceString('base');
      requireSourceString('head');
      if (typeof source.symmetric !== 'boolean') {
        throw new Error('Agent review feedback repository source symmetric must be boolean.');
      }
      if (source.baseSha !== undefined) requireSourceString('baseSha');
      if (source.headSha !== undefined) requireSourceString('headSha');
      return;
    case 'pull-request':
      requireSourceString('url');
      for (const field of ['headSha', 'host', 'owner', 'projectPath', 'repo']) {
        if (source[field] !== undefined) requireSourceString(field);
      }
      if (source.number !== undefined && !isPositiveInteger(source.number)) {
        throw new Error('Agent review feedback repository source number must be positive.');
      }
      if (
        source.provider !== undefined &&
        source.provider !== 'github' &&
        source.provider !== 'gitlab'
      ) {
        throw new Error('Agent review feedback repository source provider is invalid.');
      }
      return;
    default:
      throw new Error('Agent review feedback repository source type is invalid.');
  }
};

/** @param {import('../core/types.ts').AgentReviewFeedback} feedback */
const validateFeedback = (feedback) => {
  if (feedback?.version !== 1) {
    throw new Error('Agent review feedback must use version 1.');
  }
  if (!Array.isArray(feedback.comments) || feedback.comments.length === 0) {
    throw new Error('Agent review feedback must include at least one comment.');
  }
  if (feedback.comments.length > 500) {
    throw new Error('Agent review feedback must include at most 500 comments.');
  }
  if (!isNonEmptyString(feedback.markdown)) {
    throw new Error('Agent review feedback Markdown must not be empty.');
  }
  if (!isNonEmptyString(feedback.repository?.root)) {
    throw new Error('Agent review feedback repository root must not be empty.');
  }
  validateReviewSource(feedback.repository?.source);
  for (const [index, comment] of feedback.comments.entries()) {
    validateComment(comment);
    if (comment.order !== index + 1) {
      throw new Error('Agent review feedback comment order must match array order 1 through N.');
    }
  }
};

/**
 * @param {{root: string; source: import('../core/types.ts').ReviewSource} | undefined} feedbackRepository
 * @param {{root: string; source: import('../core/types.ts').ReviewSource}} stateRepository
 */
const validateAgentReviewRepository = (feedbackRepository, stateRepository) => {
  if (
    feedbackRepository?.root !== stateRepository.root ||
    !isDeepStrictEqual(feedbackRepository.source, stateRepository.source)
  ) {
    throw new Error('Agent review feedback does not match the sender repository.');
  }
};

/** @param {import('../core/types.ts').AgentFeedbackDeliveryRequest} request @param {unknown} value @param {Set<string>} allowedAssurances */
const validateDeliveryResponse = (request, value, allowedAssurances) => {
  if (!value || typeof value !== 'object' || value.deliveryId !== request.deliveryId) {
    throw new Error('Agent feedback acknowledgement has the wrong delivery ID.');
  }
  const response = /** @type {Record<string, unknown>} */ (value);
  if (response.status === 'rejected') {
    if (typeof response.reason !== 'string' || response.reason.trim() === '') {
      throw new Error('Agent feedback rejection must include a reason.');
    }
    return;
  }
  if (
    !['accepted', 'queued', 'already-accepted'].includes(/** @type {string} */ (response.status)) ||
    !allowedAssurances.has(/** @type {string} */ (response.assurance))
  ) {
    throw new Error('Agent feedback acknowledgement is invalid for this backend.');
  }
};

/** @param {{deliveryId: string; feedback: import('../core/types.ts').AgentReviewFeedback}} request */
const formatAgentFeedbackMessage = ({ deliveryId, feedback }) =>
  [
    `CODIFF_DELIVERY_ID ${deliveryId}`,
    '',
    feedback.markdown.trim(),
    '',
    'Address every Codiff comment in order. Do not automatically reopen Codiff after handling them.',
  ].join('\n');

/**
 * @param {{deliver: (request: import('../core/types.ts').AgentFeedbackDeliveryRequest) => Promise<import('../core/types.ts').AgentFeedbackDeliveryResponse>; probe?: (identity: import('../core/types.ts').AgentFeedbackSessionIdentity) => Promise<{available: boolean; reason?: string}>}} options
 */
const createAgentFeedbackDeliveryController = ({
  deliver,
  probe = async () => ({ available: true }),
}) => {
  const bindings = new Map();
  const inFlight = new Map();
  const terminal = new Map();

  const rememberTerminal = (binding, result) => {
    binding.terminal = result;
    terminal.set(binding.deliveryId, result);
    if (terminal.size > 1_000) terminal.delete(terminal.keys().next().value);
  };

  /** @param {number} webContentsId */
  const getBinding = (webContentsId) => {
    const binding = bindings.get(webContentsId);
    if (!binding) {
      throw new Error('Agent feedback delivery is not registered for this window.');
    }
    return binding;
  };

  /** @param {Record<string, any>} binding */
  const resolveRepository = async (binding) => {
    if (binding.repositoryValue) return binding.repositoryValue;
    const repository = await binding.repository;
    return binding.repositoryValue ?? repository;
  };

  return {
    /** @param {number} webContentsId */
    clear(webContentsId) {
      bindings.delete(webContentsId);
    },
    /** @param {number} webContentsId @param {import('../core/types.ts').AgentReviewFeedback} feedback */
    async deliver(webContentsId, feedback) {
      const binding = getBinding(webContentsId);
      const previous = binding.terminal ?? terminal.get(binding.deliveryId);
      if (previous?.kind === 'accepted') {
        return { ...previous.response, status: 'already-accepted' };
      }
      if (previous?.kind === 'ambiguous') throw previous.error;
      const pending = inFlight.get(binding.deliveryId);
      if (pending) return pending;
      const operation = (async () => {
        validateFeedback(feedback);
        const repository = await resolveRepository(binding);
        validateAgentReviewRepository(feedback.repository, repository);
        const capability = await probe({
          backend: binding.backend,
          sessionId: binding.sessionId,
        });
        if (!capability.available) {
          throw new Error(capability.reason || 'Agent feedback delivery is unavailable.');
        }
        const request = {
          backend: binding.backend,
          deliveryId: binding.deliveryId,
          feedback,
          repositoryRoot: repository.root,
          sessionId: binding.sessionId,
          version: 1,
        };
        try {
          const response = await deliver(request);
          try {
            validateDeliveryResponse(request, response, assurances[binding.backend]);
          } catch (error) {
            const wrapped = new Error(
              `${error.message} Delivery may have reached the agent. Verify the session or copy the comments before continuing.`,
            );
            rememberTerminal(binding, { error: wrapped, kind: 'ambiguous' });
            throw wrapped;
          }
          if (response.status === 'rejected') return response;
          rememberTerminal(binding, { kind: 'accepted', response });
          return response;
        } catch (error) {
          if (error?.ambiguous === true) {
            const wrapped = new Error(
              'Delivery may have reached the agent. Verify the session or copy the comments before continuing.',
            );
            rememberTerminal(binding, { error: wrapped, kind: 'ambiguous' });
            throw wrapped;
          }
          throw error;
        }
      })();
      inFlight.set(binding.deliveryId, operation);
      try {
        return await operation;
      } finally {
        if (inFlight.get(binding.deliveryId) === operation) inFlight.delete(binding.deliveryId);
      }
    },
    /** @param {number} webContentsId */
    async prepare(webContentsId) {
      const binding = getBinding(webContentsId);
      const result = await probe({
        backend: binding.backend,
        sessionId: binding.sessionId,
      });
      binding.available = result.available;
      binding.unavailableReason = result.reason;
      return result;
    },
    /** @param {number} webContentsId @param {{backend: import('../core/types.ts').AgentBackend; deliveryId: string; repository: Promise<{root: string; source: import('../core/types.ts').ReviewSource}>; sessionId: string}} binding */
    register(webContentsId, binding) {
      bindings.set(webContentsId, binding);
    },
    /** @param {number} webContentsId @param {{root: string; source: import('../core/types.ts').ReviewSource}} repository */
    setRepository(webContentsId, repository) {
      const binding = bindings.get(webContentsId);
      if (binding) binding.repositoryValue = repository;
    },
  };
};

module.exports = {
  createAgentFeedbackDeliveryController,
  formatAgentFeedbackMessage,
  validateAgentReviewRepository,
  validateFeedback,
  validateReviewSource,
};
