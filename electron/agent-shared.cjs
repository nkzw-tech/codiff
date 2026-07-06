// @ts-check

const { accessSync, constants, statSync } = require('node:fs');
const { delimiter, join } = require('node:path');

// Backend-neutral helpers shared by the Codex and Claude Code agent backends.

/** @param {unknown} value @param {string} [fallback] */
const oneLine = (value, fallback = '') =>
  (typeof value === 'string' ? value : fallback).replace(/\s+/g, ' ').trim();

const AGENT_ABORTED_CODE = 'AGENT_ABORTED';

const createAgentAbortError = () =>
  Object.assign(new Error('The agent run was canceled.'), { code: AGENT_ABORTED_CODE });

/** @param {unknown} error */
const isAgentAbortError = (error) =>
  Boolean(
    error && typeof error === 'object' && 'code' in error && error.code === AGENT_ABORTED_CODE,
  );

/**
 * Kill the agent child process when `signal` aborts, settling the run with an
 * abort error. Returns a cleanup used by the run's own settle paths.
 *
 * @param {AbortSignal | undefined} signal
 * @param {() => void} onAbort
 */
const listenForAbort = (signal, onAbort) => {
  if (!signal) {
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
};

/** @param {string} value @param {number} maxLength */
const truncate = (value, maxLength) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
};

/** @param {unknown} value @param {string} [fallback] */
const cleanText = (value, fallback = '') =>
  oneLine(value, fallback).replace(/\s*\.{3}\[truncated]$/i, '');

/** @template T @param {unknown} value @param {ReadonlySet<T>} allowed @param {T} fallback */
const normalizeEnum = (value, allowed, fallback) =>
  allowed.has(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback;

/**
 * Walk `text` and return the first balanced JSON object or array, or `null`
 * if none is found.
 *
 * @param {string} text
 * @returns {string | null}
 */
const extractFirstJson = (text) => {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (c === '\\') {
          escape = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(i, j + 1);
        }
      }
    }
  }
  return null;
};

/** @param {unknown} schema @returns {ReadonlyArray<string>} */
const schemaRequiredFields = (schema) => {
  if (!schema || typeof schema !== 'object') return [];
  const required = /** @type {any} */ (schema).required;
  if (!Array.isArray(required)) return [];
  return required.filter((field) => typeof field === 'string');
};

/**
 * @param {unknown} parsed
 * @param {ReadonlyArray<string>} required
 * @returns {boolean}
 */
const hasAllRequiredFields = (parsed, required) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const field of required) {
    if (!(field in parsed)) return false;
  }
  return true;
};

/**
 * @param {unknown} parsed
 * @param {unknown} schema
 * @returns {unknown}
 */
const coerceResultToSchema = (parsed, schema) => {
  const required = schemaRequiredFields(schema);
  if (!required.length || hasAllRequiredFields(parsed, required)) return parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;

  /** @type {Record<string, unknown>} */
  const next = { .../** @type {object} */ (parsed) };
  const aliases = [
    ['reply', 'text'],
    ['reply', 'response'],
    ['reply', 'answer'],
    ['reply', 'message'],
    ['reply', 'body'],
  ];
  for (const [target, alias] of aliases) {
    if (required.includes(target) && !(target in next) && alias in next) {
      next[target] = next[alias];
    }
  }
  return hasAllRequiredFields(next, required) ? next : parsed;
};

/** @param {unknown} schema @returns {string} */
const buildSchemaReminder = (schema) => {
  const required = schemaRequiredFields(schema);
  if (!schema || typeof schema !== 'object') return '';
  const requiredInstruction = required.length
    ? ` It must include the field${required.length === 1 ? '' : 's'} ${required
        .map((field) => `\`${field}\``)
        .join(', ')}.`
    : '';
  return `\n\nYour final reply must be a single JSON object.${requiredInstruction} Do not include any prose outside the JSON. Follow this JSON Schema exactly:\n${JSON.stringify(schema)}`;
};

/**
 * @param {string} output
 * @param {unknown} schema
 * @param {string} agentLabel
 * @returns {string}
 */
const normalizeStructuredOutput = (output, schema, agentLabel) => {
  const text = output.trim();
  const serialize = (value) => JSON.stringify(coerceResultToSchema(value, schema));

  try {
    return serialize(JSON.parse(text));
  } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return serialize(JSON.parse(fenced[1].trim()));
    } catch {}
  }

  const balanced = extractFirstJson(text);
  if (balanced) {
    try {
      return serialize(JSON.parse(balanced));
    } catch {}
  }

  if (text) {
    return JSON.stringify({ text });
  }

  throw new Error(`${agentLabel} did not produce a final answer.`);
};

/** @param {string} message @returns {unknown} */
const parseJSONMessage = (message) => {
  try {
    return JSON.parse(message);
  } catch {
    const match = message.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('The agent did not return JSON.');
    }

    return JSON.parse(match[0]);
  }
};

/** @param {string} path */
const isExecutableFile = (path) => {
  try {
    return statSync(path).isFile() && (accessSync(path, constants.X_OK), true);
  } catch {
    return false;
  }
};

/** @param {string} command */
const getExecutableNames = (command) => {
  if (process.platform !== 'win32') {
    return [command];
  }

  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
};

/** @param {string} command */
const findExecutableOnPath = (command) => {
  const path = process.env.PATH;
  if (!path) {
    return null;
  }

  for (const directory of path.split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const executable of getExecutableNames(command)) {
      const candidate = join(directory, executable);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

module.exports = {
  buildSchemaReminder,
  createAgentAbortError,
  isAgentAbortError,
  listenForAbort,
  cleanText,
  findExecutableOnPath,
  getExecutableNames,
  isExecutableFile,
  normalizeEnum,
  normalizeStructuredOutput,
  oneLine,
  parseJSONMessage,
  truncate,
};
