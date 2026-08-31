// @ts-check

const { randomUUID } = require('node:crypto');
const { renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

/**
 * @param {string} path
 * @param {import('../core/types.ts').AgentReviewResult} result
 */
const writeAgentReviewResult = (path, result) => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(result)}\n`, 'utf8');
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
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
      if (source.baseRef !== undefined) {
        requireSourceString('baseRef');
      }
      if (source.headRef !== undefined) {
        requireSourceString('headRef');
      }
      return;
    case 'range':
      requireSourceString('base');
      requireSourceString('head');
      if (typeof source.symmetric !== 'boolean') {
        throw new Error('Agent review feedback repository source symmetric must be boolean.');
      }
      return;
    case 'pull-request':
      requireSourceString('url');
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
  if (!isNonEmptyString(feedback.markdown)) {
    throw new Error('Agent review feedback Markdown must not be empty.');
  }
  if (!isNonEmptyString(feedback.repository?.root)) {
    throw new Error('Agent review feedback repository root must not be empty.');
  }
  validateReviewSource(feedback.repository?.source);
  for (const comment of feedback.comments) {
    validateComment(comment);
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

/**
 * @param {{writeResult?: typeof writeAgentReviewResult}} [options]
 */
const createAgentReviewHandoffController = ({ writeResult = writeAgentReviewResult } = {}) => {
  const completed = new Set();

  return {
    /** @param {number} webContentsId */
    clear(webContentsId) {
      completed.delete(webContentsId);
    },
    /**
     * @param {number} webContentsId
     * @param {string} path
     * @param {{root: string; source: import('../core/types.ts').ReviewSource}} repository
     */
    close(webContentsId, path, repository) {
      if (completed.has(webContentsId)) {
        return false;
      }
      writeResult(path, {
        comments: [],
        markdown: '',
        repository,
        status: 'closed',
        version: 1,
      });
      completed.add(webContentsId);
      return true;
    },
    /**
     * @param {number} webContentsId
     * @param {string} path
     * @param {import('../core/types.ts').AgentReviewFeedback} feedback
     */
    complete(webContentsId, path, feedback) {
      if (completed.has(webContentsId)) {
        return false;
      }
      validateFeedback(feedback);
      writeResult(path, { ...feedback, status: 'submitted' });
      completed.add(webContentsId);
      return true;
    },
    /** @param {number} webContentsId */
    hasCompleted(webContentsId) {
      return completed.has(webContentsId);
    },
  };
};

/**
 * @param {{controller?: ReturnType<typeof createAgentReviewHandoffController>}} [options]
 */
const createAgentReviewHandoffLifecycle = ({
  controller = createAgentReviewHandoffController(),
} = {}) => {
  /**
   * @typedef {{
   *   activeOperations: number;
   *   cleared: boolean;
   *   repository?: {root: string; source: import('../core/types.ts').ReviewSource};
   *   repositoryOutcome: Promise<
   *     | {repository: {root: string; source: import('../core/types.ts').ReviewSource}}
   *     | {error: unknown}
   *   >;
   *   resultPath: string;
   * }} Handoff
   */
  /** @type {Map<number, Handoff>} */
  const handoffs = new Map();

  /** @param {number} webContentsId */
  const getHandoff = (webContentsId) => {
    const handoff = handoffs.get(webContentsId);
    if (!handoff) {
      throw new Error('Agent review handoff is not registered for this window.');
    }
    return handoff;
  };

  /** @param {number} webContentsId @param {Handoff} handoff */
  const finishOperation = (webContentsId, handoff) => {
    handoff.activeOperations -= 1;
    if (handoff.cleared && handoff.activeOperations === 0) {
      controller.clear(webContentsId);
    }
  };

  /** @param {Handoff} handoff */
  const resolveRepository = async (handoff) => {
    if (handoff.repository) {
      return handoff.repository;
    }
    const outcome = await handoff.repositoryOutcome;
    if ('error' in outcome) {
      throw outcome.error;
    }
    handoff.repository = outcome.repository;
    return outcome.repository;
  };

  return {
    /** @param {number} webContentsId */
    clear(webContentsId) {
      const handoff = handoffs.get(webContentsId);
      if (!handoff) {
        controller.clear(webContentsId);
        return;
      }
      handoffs.delete(webContentsId);
      handoff.cleared = true;
      if (handoff.activeOperations === 0) {
        controller.clear(webContentsId);
      }
    },
    /** @param {number} webContentsId */
    async close(webContentsId) {
      const handoff = getHandoff(webContentsId);
      handoff.activeOperations += 1;
      try {
        let repository;
        try {
          repository = await resolveRepository(handoff);
        } catch {
          return 'repository-unavailable';
        }
        return controller.close(webContentsId, handoff.resultPath, repository)
          ? 'closed'
          : 'already-completed';
      } finally {
        finishOperation(webContentsId, handoff);
      }
    },
    /**
     * @param {number} webContentsId
     * @param {import('../core/types.ts').AgentReviewFeedback} feedback
     */
    async complete(webContentsId, feedback) {
      const handoff = getHandoff(webContentsId);
      handoff.activeOperations += 1;
      try {
        const repository = await resolveRepository(handoff);
        validateAgentReviewRepository(feedback?.repository, repository);
        return controller.complete(webContentsId, handoff.resultPath, feedback);
      } finally {
        finishOperation(webContentsId, handoff);
      }
    },
    /**
     * @param {number} webContentsId
     * @param {string} resultPath
     * @param {Promise<{root: string; source: import('../core/types.ts').ReviewSource}>} repositoryPromise
     */
    register(webContentsId, resultPath, repositoryPromise) {
      handoffs.set(webContentsId, {
        activeOperations: 0,
        cleared: false,
        repositoryOutcome: repositoryPromise.then(
          (repository) => ({ repository }),
          (error) => ({ error }),
        ),
        resultPath,
      });
    },
    /**
     * @param {number} webContentsId
     * @param {{root: string; source: import('../core/types.ts').ReviewSource}} repository
     */
    setRepository(webContentsId, repository) {
      const handoff = handoffs.get(webContentsId);
      if (handoff) {
        handoff.repository = repository;
      }
    },
  };
};

module.exports = {
  createAgentReviewHandoffController,
  createAgentReviewHandoffLifecycle,
  validateAgentReviewRepository,
  validateFeedback,
  validateReviewSource,
  writeAgentReviewResult,
};
