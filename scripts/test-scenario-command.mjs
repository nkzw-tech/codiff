import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

export const DEFAULT_SCENARIO_COMMAND_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SCENARIO_COMMAND_TIMEOUT_MS = 120_000;

export class ScenarioCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ScenarioCommandError';
  }
}

/**
 * @param {{
 *   args: ReadonlyArray<string>,
 *   capture?: boolean,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   executable: string,
 *   maxBytes?: number,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} options
 */
export const runScenarioCommand = ({
  args,
  capture = false,
  cwd,
  env = {},
  executable,
  maxBytes = DEFAULT_SCENARIO_COMMAND_MAX_BYTES,
  signal = undefined,
  timeoutMs = DEFAULT_SCENARIO_COMMAND_TIMEOUT_MS,
}) => {
  if (signal?.aborted) {
    return Promise.reject(
      new ScenarioCommandError(
        'aborted',
        `${executable} ${args.join(' ')} was canceled by the caller.`,
      ),
    );
  }
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let termination = null;
    let killTimer = null;

    const terminate = (code, message) => {
      if (termination) {
        return;
      }
      termination = new ScenarioCommandError(code, message);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref?.();
    };
    const record = (target, stream, chunk) => {
      const bytes = Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > maxBytes) {
        terminate(
          'output-limit',
          `${executable} ${args.join(' ')} exceeded the ${maxBytes}-byte output limit.`,
        );
        return;
      }
      target.push(bytes);
      if (!capture) {
        stream.write(bytes);
      }
    };
    child.stdout?.on('data', (chunk) => record(stdout, process.stdout, chunk));
    child.stderr?.on('data', (chunk) => record(stderr, process.stderr, chunk));

    const timeout = setTimeout(
      () =>
        terminate(
          'timeout',
          `${executable} ${args.join(' ')} timed out after ${timeoutMs} milliseconds.`,
        ),
      timeoutMs,
    );
    timeout.unref?.();
    const onAbort = () =>
      terminate('aborted', `${executable} ${args.join(' ')} was canceled by the caller.`);
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      cleanup();
      rejectCommand(error);
    });
    child.on('close', (code, childSignal) => {
      cleanup();
      if (termination) {
        rejectCommand(termination);
        return;
      }
      if (code === 0) {
        resolveCommand(capture ? Buffer.concat(stdout).toString('utf8').trim() : '');
        return;
      }
      rejectCommand(
        new ScenarioCommandError(
          'exit',
          `${executable} ${args.join(' ')} exited with ${code ?? childSignal ?? 'unknown'}: ${Buffer.concat(
            stderr,
          )
            .toString('utf8')
            .trim()}`,
        ),
      );
    });
  });
};
