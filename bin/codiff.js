#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import {
  formatHelpText,
  getReviewSource,
  parseArguments,
  resolvePullRequestUrl,
} from './arguments.js';
import { waitForPlanResult } from './plan-result.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const {
  generateAndShareWalkthrough,
  shareWalkthroughFile,
} = require('../electron/headless-walkthrough-share.cjs');
const { sharePlanFile } = require('../electron/headless-plan-share.cjs');

// The renderer is the built dist/ by default. When Codiff's own Vite dev server
// is running, use it instead so source edits hot-reload without a rebuild. The
// server is VERIFIED to identify as Codiff before it's trusted — 5173 is a
// common dev port, so "something is listening" is never enough on its own.
const DEV_SERVER_URL = process.env.CODIFF_DEV_SERVER_URL || 'http://127.0.0.1:5173';

const looksLikeCodiff = (body) =>
  body.includes('<title>Codiff</title>') && body.includes('/core/index.tsx');

/** Resolve to the dev-server URL when it is up and serving Codiff, else `null`. */
const detectDevServer = (url) =>
  new Promise((resolveProbe) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolveProbe(value ? url : null);
      }
    };

    let target;
    try {
      target = new URL(url);
    } catch {
      finish(false);
      return;
    }

    const request = (target.protocol === 'https:' ? https : http).get(target, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(false);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65_536) {
          response.destroy();
        }
      });
      response.on('end', () => finish(looksLikeCodiff(body)));
      response.on('close', () => finish(looksLikeCodiff(body)));
    });
    request.setTimeout(800, () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => finish(false));
  });

const openExternal = (url) =>
  new Promise((resolveOpen, reject) => {
    const command =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '""', url] : [url];
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveOpen();
    });
  });

// Assemble the narrative walkthrough authoring guide: the prose, then the live
// schema object serialized inline (single-sourced from the validator — no copy).
const buildWalkthroughGuide = () => {
  const { narrativeWalkthroughSchema } = require(
    resolve(root, 'electron/narrative-walkthrough.cjs'),
  );
  const guide = readFileSync(resolve(root, 'bin/walkthrough-guide.md'), 'utf8').trimEnd();
  return `${guide}\n\n\`\`\`json\n${JSON.stringify(narrativeWalkthroughSchema, null, 2)}\n\`\`\`\n`;
};

const run = async () => {
  const parsedArguments = parseArguments(process.argv.slice(2));

  if (parsedArguments.help) {
    process.stdout.write(formatHelpText(packageJson.version));
    return;
  }

  if (parsedArguments.version) {
    process.stdout.write(`codiff v${packageJson.version}\n`);
    return;
  }

  if (parsedArguments.walkthroughGuide) {
    process.stdout.write(buildWalkthroughGuide());
    return;
  }

  const {
    agentBackend,
    branchRef,
    claudeSessionId,
    codexSessionId,
    commitRef,
    opencodeSessionId,
    piSessionId,
    planFilePath,
    pullRequestBranch,
    pullRequestProvider,
    range,
    requestedPath,
    share,
    walkthrough,
    walkthroughContextPath,
    walkthroughFilePath,
  } = parsedArguments;
  let { pullRequestNumber, pullRequestUrl } = parsedArguments;

  if (planFilePath && (!existsSync(planFilePath) || !/\.md$/i.test(planFilePath))) {
    process.stderr.write(`codiff: plan file not found or not Markdown: ${planFilePath}\n`);
    process.exitCode = 1;
    return;
  }
  if (pullRequestBranch && !pullRequestUrl && pullRequestNumber == null) {
    if (pullRequestProvider === 'gitlab') {
      process.stderr.write('codiff: branch lookup is GitHub-only for now.\n');
      process.exit(1);
    }
    // Branch lookup currently supports GitHub only.
    try {
      const output = execFileSync(
        'gh',
        ['pr', 'view', pullRequestBranch, '--json', 'number', '-q', '.number'],
        { cwd: requestedPath, encoding: 'utf8' },
      ).trim();
      if (!/^[1-9]\d*$/.test(output)) {
        throw new Error('No open pull request found.');
      }
      pullRequestNumber = Number(output);
    } catch (error) {
      const message =
        error instanceof Error && error.message === 'No open pull request found.'
          ? error.message
          : `Could not find an open pull request for branch "${pullRequestBranch}".`;
      process.stderr.write(`codiff: ${message}\n`);
      process.exit(1);
    }
  }

  if (!pullRequestUrl && pullRequestNumber != null) {
    try {
      pullRequestUrl = resolvePullRequestUrl(
        requestedPath,
        pullRequestNumber,
        pullRequestProvider ?? undefined,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  if (share) {
    if (planFilePath) {
      const sessionId =
        agentBackend === 'claude'
          ? claudeSessionId
          : agentBackend === 'opencode'
            ? opencodeSessionId
            : agentBackend === 'pi'
              ? piSessionId
              : codexSessionId;
      try {
        const url = await sharePlanFile({
          agent: agentBackend ?? undefined,
          codiffVersion: packageJson.version,
          openExternal,
          planFile: planFilePath,
          serviceUrlOverride: process.env.CODIFF_SHARE_SERVER_URL,
          sessionId: sessionId ?? undefined,
        });
        process.stdout.write(`${url}\n`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
      return;
    }

    const source = getReviewSource({
      branchRef,
      commitRef,
      pullRequestProvider,
      pullRequestUrl,
      range,
    });

    try {
      const commonOptions = {
        agent: agentBackend ?? undefined,
        codiffVersion: packageJson.version,
        openExternal,
        repositoryPath: requestedPath,
        serviceUrlOverride: process.env.CODIFF_SHARE_SERVER_URL,
        source,
      };
      const url = walkthroughFilePath
        ? await shareWalkthroughFile({
            ...commonOptions,
            walkthroughFile: walkthroughFilePath,
          })
        : await generateAndShareWalkthrough({
            ...commonOptions,
            claudeSessionId,
            codexSessionId,
            opencodeSessionId,
            piSessionId,
            walkthroughContextPath,
          });
      process.stdout.write(`${url}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // Prefer an explicit ELECTRON_RENDERER_URL; otherwise auto-use Codiff's dev
  // server when it is actually running and identifies as Codiff.
  const rendererURL =
    process.env.ELECTRON_RENDERER_URL || (await detectDevServer(DEV_SERVER_URL)) || '';

  if (!rendererURL && !existsSync(resolve(root, 'dist/index.html'))) {
    console.error('Codiff has not been built yet. Run `pnpm build` first, or start `pnpm dev`.');
    process.exit(1);
  }

  const planResultDirectory = planFilePath
    ? mkdtempSync(join(tmpdir(), 'codiff-plan-result-'))
    : null;
  const planResultPath = planResultDirectory ? join(planResultDirectory, 'result.json') : '';
  const childEnv = {
    ...process.env,
    CODIFF_AGENT_BACKEND: agentBackend ?? '',
    CODIFF_BRANCH_REF: branchRef ?? '',
    CODIFF_CLAUDE_SESSION_ID: claudeSessionId ?? '',
    CODIFF_COMMIT_REF: commitRef ?? '',
    CODIFF_CODEX_SESSION_ID: codexSessionId ?? '',
    CODIFF_OPENCODE_SESSION_ID: opencodeSessionId ?? '',
    CODIFF_PI_SESSION_ID: piSessionId ?? '',
    CODIFF_PLAN_FILE: planFilePath ?? '',
    CODIFF_PLAN_RESULT_FILE: planResultPath,
    CODIFF_PULL_REQUEST_URL: pullRequestUrl ?? '',
    CODIFF_REVIEW_PROVIDER: pullRequestProvider ?? '',
    CODIFF_RANGE: range ? `${range.base}${range.symmetric ? '...' : '..'}${range.head}` : '',
    CODIFF_REPOSITORY_PATH: requestedPath,
    CODIFF_WALKTHROUGH: walkthrough ? '1' : '',
    CODIFF_WALKTHROUGH_CONTEXT: walkthroughContextPath ?? '',
    CODIFF_WALKTHROUGH_FILE: walkthroughFilePath ?? '',
    ELECTRON_RENDERER_URL: rendererURL,
  };

  // Electron must launch as a GUI. Some launchers (e.g. an agent/CLI harness)
  // export ELECTRON_RUN_AS_NODE=1, which makes the electron binary run as plain
  // Node — `require('electron')` then returns a path string and the app crashes
  // on boot. Strip it (and the console-detach flag) so the window always opens.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

  const { default: electron } = await import('electron');

  const child = spawn(electron, [root], {
    detached: true,
    env: childEnv,
    stdio: 'ignore',
  });

  child.unref();
  if (planResultDirectory) {
    try {
      const result = await waitForPlanResult(planResultPath, child);
      if (result.status === 'canceled') {
        process.exitCode = 2;
      } else {
        process.stdout.write(`CODIFF_PLAN_RESULT ${JSON.stringify(result)}\n`);
      }
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Codiff could not open the plan.'}\n`,
      );
      process.exitCode = 1;
    } finally {
      rmSync(planResultDirectory, { force: true, recursive: true });
    }
  }
};

run();
