#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';
import packageJson from '../package.json' with { type: 'json' };
import { parseArguments, resolvePullRequestUrl } from './arguments.js';

const require = createRequire(import.meta.url);
const { shareWalkthroughFile } = require('../electron/headless-walkthrough-share.cjs');
const { sharePlanFile } = require('../electron/headless-plan-share.cjs');

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

const rawArgs = process.argv.slice(2);
const forwardedArgs = [];
let openResult = false;
let planFile = '';
let walkthroughFile = '';

for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === '--file') {
    walkthroughFile = rawArgs[index + 1] || '';
    index += 1;
    continue;
  }
  if (arg.startsWith('--file=')) {
    walkthroughFile = arg.slice('--file='.length);
    continue;
  }
  if (arg === '--plan') {
    planFile = rawArgs[index + 1] || '';
    index += 1;
    continue;
  }
  if (arg.startsWith('--plan=')) {
    planFile = arg.slice('--plan='.length);
    continue;
  }
  if (arg === '--open') {
    openResult = true;
    continue;
  }
  forwardedArgs.push(arg);
}

if (!walkthroughFile && !planFile) {
  process.stderr.write('share-codiff: missing --file <path> or --plan <path>.\n');
  process.exit(1);
}

const walkthroughFilePath = walkthroughFile ? resolve(walkthroughFile) : '';
const planFilePath = planFile ? resolve(planFile) : '';
if (walkthroughFilePath && !existsSync(walkthroughFilePath)) {
  process.stderr.write(`share-codiff: walkthrough file not found at ${walkthroughFilePath}.\n`);
  process.exit(1);
}
if (planFilePath && (!existsSync(planFilePath) || !/\.md$/i.test(planFilePath))) {
  process.stderr.write(`share-codiff: plan file not found or not Markdown: ${planFilePath}.\n`);
  process.exit(1);
}

const parsed = parseArguments(forwardedArgs);
let pullRequestUrl = parsed.pullRequestUrl;
if (!pullRequestUrl && parsed.pullRequestNumber != null) {
  pullRequestUrl = resolvePullRequestUrl(
    parsed.requestedPath,
    parsed.pullRequestNumber,
    parsed.pullRequestProvider,
  );
}

const source = parsed.arc
  ? parsed.arcRange
    ? {
        base: parsed.arcRange.base,
        head: parsed.arcRange.head,
        symmetric: parsed.arcRange.symmetric,
        type: 'arc-range',
      }
    : parsed.arcCommitRef
      ? {
          ref: parsed.arcCommitRef,
          type: 'arc-commit',
        }
      : parsed.arcPullRequestNumber != null
        ? {
            number: parsed.arcPullRequestNumber,
            type: 'arc-pull-request',
          }
        : parsed.arcBase
          ? {
              base: parsed.arcBase,
              type: 'arc-branch',
            }
          : {
              type: 'arc-working-tree',
            }
  : parsed.range
    ? {
        base: parsed.range.base,
        head: parsed.range.head,
        symmetric: parsed.range.symmetric,
        type: 'range',
      }
    : pullRequestUrl
      ? {
          ...(parsed.pullRequestProvider ? { provider: parsed.pullRequestProvider } : {}),
          type: 'pull-request',
          url: pullRequestUrl,
        }
      : parsed.commitRef
        ? { ref: parsed.commitRef, type: 'commit' }
        : parsed.branchRef
          ? { ref: parsed.branchRef, type: 'branch' }
          : { type: 'working-tree' };

try {
  const sessionId =
    parsed.agentBackend === 'claude'
      ? parsed.claudeSessionId
      : parsed.agentBackend === 'opencode'
        ? parsed.opencodeSessionId
        : parsed.agentBackend === 'pi'
          ? parsed.piSessionId
          : parsed.codexSessionId;
  const url = planFilePath
    ? await sharePlanFile({
        agent: parsed.agentBackend ?? undefined,
        codiffVersion: packageJson.version,
        openExternal,
        planFile: planFilePath,
        serviceUrlOverride: process.env.CODIFF_SHARE_SERVER_URL,
        sessionId: sessionId ?? undefined,
      })
    : await shareWalkthroughFile({
        agent: parsed.agentBackend ?? undefined,
        codiffVersion: packageJson.version,
        openExternal,
        repositoryPath: parsed.requestedPath,
        serviceUrlOverride: process.env.CODIFF_SHARE_SERVER_URL,
        source,
        walkthroughFile: walkthroughFilePath,
      });
  if (openResult) {
    await openExternal(url);
  }
  process.stdout.write(`${url}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
