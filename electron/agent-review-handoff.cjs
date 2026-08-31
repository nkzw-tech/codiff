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

/** @param {import('../core/types.ts').AgentReviewFeedback} feedback */
const validateFeedback = (feedback) => {
  if (feedback?.version !== 1) {
    throw new Error('Agent review feedback must use version 1.');
  }
  if (!Array.isArray(feedback.comments) || feedback.comments.length === 0) {
    throw new Error('Agent review feedback must include at least one comment.');
  }
  if (typeof feedback.markdown !== 'string' || feedback.markdown.trim() === '') {
    throw new Error('Agent review feedback Markdown must not be empty.');
  }
  if (
    feedback.comments.some(
      (comment) => typeof comment?.body !== 'string' || comment.body !== comment.body.trim(),
    )
  ) {
    throw new Error('Agent review feedback comment bodies must be non-empty and trimmed.');
  }
  if (feedback.comments.some((comment) => comment.body === '')) {
    throw new Error('Agent review feedback comment bodies must be non-empty and trimmed.');
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
        return;
      }
      writeResult(path, {
        comments: [],
        markdown: '',
        repository,
        status: 'closed',
        version: 1,
      });
      completed.add(webContentsId);
    },
    /**
     * @param {number} webContentsId
     * @param {string} path
     * @param {import('../core/types.ts').AgentReviewFeedback} feedback
     */
    complete(webContentsId, path, feedback) {
      if (completed.has(webContentsId)) {
        return;
      }
      validateFeedback(feedback);
      writeResult(path, { ...feedback, status: 'submitted' });
      completed.add(webContentsId);
    },
    /** @param {number} webContentsId */
    hasCompleted(webContentsId) {
      return completed.has(webContentsId);
    },
  };
};

module.exports = {
  createAgentReviewHandoffController,
  validateAgentReviewRepository,
  writeAgentReviewResult,
};
