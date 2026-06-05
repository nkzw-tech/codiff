#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import packageJson from '../package.json' with { type: 'json' };
import { formatHelpText, parseArguments, resolvePullRequestUrl } from './arguments.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assemble the narrative walkthrough authoring guide: the prose, then the live
// schema object serialized inline (single-sourced from the validator — no copy).
const buildWalkthroughGuide = () => {
  const require = createRequire(import.meta.url);
  const { narrativeWalkthroughSchema } = require(
    resolve(root, 'electron/narrative-walkthrough.cjs'),
  );
  const guide = readFileSync(resolve(root, 'bin/walkthrough-guide.md'), 'utf8').trimEnd();
  return `${guide}\n\n\`\`\`json\n${JSON.stringify(narrativeWalkthroughSchema, null, 2)}\n\`\`\`\n`;
};

const run = () => {
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
    pullRequestNumber,
    requestedPath,
    walkthrough,
    walkthroughContextPath,
    walkthroughFilePath,
  } = parsedArguments;
  let { pullRequestUrl } = parsedArguments;

  if (!pullRequestUrl && pullRequestNumber != null) {
    try {
      pullRequestUrl = resolvePullRequestUrl(requestedPath, pullRequestNumber);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  if (!existsSync(resolve(root, 'dist/index.html')) && !process.env.ELECTRON_RENDERER_URL) {
    console.error('Codiff has not been built yet. Run `pnpm build` first.');
    process.exit(1);
  }

  const child = spawn(electron, [root], {
    detached: true,
    env: {
      ...process.env,
      CODIFF_AGENT_BACKEND: agentBackend ?? '',
      CODIFF_BRANCH_REF: branchRef ?? '',
      CODIFF_CLAUDE_SESSION_ID: claudeSessionId ?? '',
      CODIFF_COMMIT_REF: commitRef ?? '',
      CODIFF_CODEX_SESSION_ID: codexSessionId ?? '',
      CODIFF_PULL_REQUEST_URL: pullRequestUrl ?? '',
      CODIFF_REPOSITORY_PATH: requestedPath,
      CODIFF_WALKTHROUGH: walkthrough ? '1' : '',
      CODIFF_WALKTHROUGH_CONTEXT: walkthroughContextPath ?? '',
      CODIFF_WALKTHROUGH_FILE: walkthroughFilePath ?? '',
    },
    stdio: 'ignore',
  });

  child.unref();
};

run();
