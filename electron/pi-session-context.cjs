// @ts-check

const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { cleanText, truncate } = require('./agent-shared.cjs');

const MAX_SESSION_SCAN_FILES = 20_000;
const MAX_SESSION_MESSAGE_CHARS = 2_400;
const MAX_SESSION_MESSAGES = 18;
const MAX_SESSION_CONTEXT_CHARS = 28_000;

/**
 * @typedef {import('../src/types.ts').WalkthroughContext} WalkthroughContext
 */

/** @param {unknown} value */
const normalizePiSessionId = (value) => (typeof value === 'string' ? value : '');

const getPiHome = () => process.env.PI_HOME || join(homedir(), '.pi');

/** @param {unknown} value */
const extractContentText = (value) => {
  if (typeof value === 'string') {
    return cleanText(value);
  }

  if (!Array.isArray(value)) {
    return '';
  }

  return cleanText(
    value
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }

        if (
          'type' in item &&
          item.type === 'text' &&
          'text' in item &&
          typeof item.text === 'string'
        ) {
          return item.text;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n'),
  );
};

/** @param {string} text */
const isNoiseMessage = (text) => {
  const normalized = cleanText(text).toLowerCase();
  return (
    normalized === '/codiff' ||
    normalized === 'codiff' ||
    normalized === 'show me codiff' ||
    normalized === 'open codiff'
  );
};

/** @param {string} path @param {string} sessionId */
const pathMatchesSessionId = (path, sessionId) =>
  path.toLowerCase().includes(sessionId.toLowerCase());

/**
 * @param {string} root
 * @param {string} sessionId
 */
const findPiSessionFile = (root, sessionId) => {
  if (!sessionId || !existsSync(root)) {
    return null;
  }

  /** @type {Array<string>} */
  const stack = [root];
  let scanned = 0;

  while (stack.length > 0 && scanned < MAX_SESSION_SCAN_FILES) {
    const directory = stack.pop();
    if (!directory) {
      continue;
    }

    /** @type {Array<import('node:fs').Dirent>} */
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        b.name.localeCompare(a.name),
      );
    } catch {
      continue;
    }

    for (const entry of entries) {
      scanned += 1;
      const path = join(directory, entry.name);
      if (entry.isFile() && path.endsWith('.jsonl') && pathMatchesSessionId(path, sessionId)) {
        return path;
      }

      if (entry.isDirectory()) {
        stack.push(path);
      }

      if (scanned >= MAX_SESSION_SCAN_FILES) {
        break;
      }
    }
  }

  return null;
};

/** @param {unknown} input */
const extractMessage = (input) => {
  if (!input || typeof input !== 'object') {
    return null;
  }

  if (!('type' in input) || (input.type !== 'user' && input.type !== 'assistant')) {
    return null;
  }

  const message = 'message' in input ? input.message : null;
  if (!message || typeof message !== 'object') {
    return null;
  }

  const role = 'role' in message ? message.role : undefined;
  if (role !== 'assistant' && role !== 'user') {
    return null;
  }

  const text = truncate(
    extractContentText('content' in message ? message.content : null),
    MAX_SESSION_MESSAGE_CHARS,
  );
  if (!text || isNoiseMessage(text)) {
    return null;
  }

  return { role, text };
};

/** @param {string} sessionPath */
const readSessionMessages = (sessionPath) => {
  const stat = statSync(sessionPath);
  if (!stat.isFile()) {
    return [];
  }

  /** @type {Array<{role: 'assistant' | 'user'; text: string}>} */
  const messages = [];
  let totalChars = 0;

  for (const line of readFileSync(sessionPath, 'utf8').split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      const message = extractMessage(JSON.parse(line));
      if (!message) {
        continue;
      }

      messages.push(message);
    } catch {
      // Ignore malformed or future-format records in Pi session logs.
    }
  }

  /** @type {Array<{role: 'assistant' | 'user'; text: string}>} */
  const selected = [];
  for (const message of messages.slice().reverse()) {
    if (selected.length >= MAX_SESSION_MESSAGES) {
      break;
    }

    const cost = message.role.length + message.text.length + 2;
    if (selected.length > 0 && totalChars + cost > MAX_SESSION_CONTEXT_CHARS) {
      break;
    }

    selected.push(message);
    totalChars += cost;
  }

  return selected.reverse();
};

/**
 * @param {string | undefined} piSessionId
 * @returns {WalkthroughContext | null}
 */
const readPiSessionContext = (piSessionId) => {
  const threadId = normalizePiSessionId(piSessionId);
  if (!threadId) {
    return null;
  }

  const path = findPiSessionFile(join(getPiHome(), 'agent', 'sessions'), threadId);
  const messages = path ? readSessionMessages(path) : [];

  return {
    messages,
    risks:
      messages.length === 0
        ? ['Codiff could not find recent readable messages for the linked Pi session.']
        : undefined,
    source: {
      generatedAt: new Date().toISOString(),
      threadId,
      type: 'pi-session-excerpt',
    },
    version: 1,
  };
};

module.exports = {
  findPiSessionFile,
  readPiSessionContext,
  readSessionMessages,
};
