import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getWalkthroughMetrics, nowMs, roundMs, writeJson } from '../lib.mjs';
import { buildEvalShareManifest, computeFixtureDigest } from '../review-artifacts.mjs';

const require = createRequire(import.meta.url);

export const kind = 'single-commit';

export const buildJudgePrompt = ({
  evalCase,
  walkthrough,
}) => `You are judging the quality of a Codiff narrative code walkthrough for commit ${evalCase.commit}.

Inspect the commit directly with read-only git commands. Judge the candidate as a reviewer-facing path through the change, not as a generic summary. Hunk IDs are deterministic anchors; verify the prose and ordering against the actual diff. Do not reward verbosity.

Case rubric:
${evalCase.rubric.map((item) => `- ${item}`).join('\n')}

Candidate walkthrough:
${walkthrough}

Scoring:
- factualGrounding (0-35): statements match the diff; no invented behavior, tests, risks, or intent.
- prioritization (0-30): main stops cover the highest-leverage behavior in a useful review order; mechanical changes are support.
- organization (0-20): coherent conceptual chapters, sensible grouping, concise reviewer path.
- specificity (0-15): prose names concrete symbols, contracts, and interactions rather than generic file summaries.
- total must equal the four component scores.

Be strict and consistent. Put material factual or coverage failures in majorErrors.`;

export const runAttempt = async ({
  attempt,
  attemptDir,
  effort,
  evalCase,
  model,
  prepareOnly,
  root,
}) => {
  const { getAgent } = require('../../electron/agent.cjs');
  const { readRepositoryState } = require('../../electron/git-state.cjs');
  const {
    buildNarrativeWalkthroughPrompt,
    readNarrativeWalkthrough,
  } = require('../../electron/narrative-walkthrough.cjs');

  const stateStarted = nowMs();
  const state = await readRepositoryState(root, {
    ref: evalCase.commit,
    type: 'commit',
  });
  const stateMs = roundMs(nowMs() - stateStarted);
  const promptStarted = nowMs();
  const expectedPrompt = await buildNarrativeWalkthroughPrompt(state, null, 'Codex');
  const promptBuildMs = roundMs(nowMs() - promptStarted);
  const fixtureDigest = computeFixtureDigest({
    commit: evalCase.commit,
    files: state.files,
    rubric: evalCase.rubric,
    source: state.source,
  });
  await writeFile(join(attemptDir, 'prompt.txt'), expectedPrompt);

  if (prepareOnly) {
    return {
      meta: {
        agentMs: null,
        commit: evalCase.commit,
        effort,
        exitStatus: 'prepared',
        firstResponseMs: null,
        fixtureDigest,
        generationMs: 0,
        metrics: null,
        model,
        modelCalls: 0,
        phases: [],
        postprocessMs: null,
        promptBuildMs,
        promptChars: expectedPrompt.length,
        rawResponseChars: 0,
        reason: null,
        stateMs,
        transport: null,
        usage: null,
        variant: kind,
      },
      summary: `${evalCase.id} attempt ${attempt}: prepared, ${expectedPrompt.length} prompt chars`,
    };
  }

  const baseAgent = getAgent('codex');
  let rawResponse = '';
  let actualPrompt = '';
  let agentStartedAt = 0;
  let agentFinishedAt = 0;
  let agentMetrics = null;
  const phases = [];
  const generationStarted = nowMs();
  const agent = {
    ...baseAgent,
    run: async (...runArgs) => {
      actualPrompt = runArgs[1];
      agentStartedAt = nowMs();
      try {
        rawResponse = await baseAgent.run(...runArgs);
        return rawResponse;
      } finally {
        agentFinishedAt = nowMs();
      }
    },
  };
  const result = await readNarrativeWalkthrough(
    state,
    agent,
    {
      fallbackModel: baseAgent.fallbackModel,
      model,
      onMetrics: (metrics) => {
        agentMetrics = metrics;
      },
      onProgress: (phase) => {
        phases.push({ elapsedMs: roundMs(nowMs() - generationStarted), phase });
      },
      reasoningEffort: effort,
    },
    null,
  );
  const generationFinished = nowMs();
  const firstResponse = phases.find((event) => event.phase === 'response-received');

  if (actualPrompt && actualPrompt !== expectedPrompt) {
    await writeFile(join(attemptDir, 'actual-prompt.txt'), actualPrompt);
  }
  if (rawResponse) {
    await writeFile(join(attemptDir, 'raw-response.txt'), rawResponse);
  }
  if (result.status === 'ready') {
    await writeJson(join(attemptDir, 'walkthrough.json'), result.walkthrough);
    await writeJson(
      join(attemptDir, 'share-manifest.json'),
      buildEvalShareManifest({
        artifactId: `single-commit/${evalCase.id}`,
        state,
        walkthrough: result.walkthrough,
      }),
    );
  }

  const generationMs = roundMs(generationFinished - generationStarted);
  return {
    meta: {
      agentMs: agentStartedAt && agentFinishedAt ? roundMs(agentFinishedAt - agentStartedAt) : null,
      commit: evalCase.commit,
      effort,
      exitStatus: result.status,
      firstResponseMs: firstResponse?.elapsedMs ?? null,
      fixtureDigest,
      generationMs,
      metrics: result.status === 'ready' ? getWalkthroughMetrics(state, result.walkthrough) : null,
      model,
      modelCalls: 1,
      phases,
      postprocessMs: agentFinishedAt ? roundMs(generationFinished - agentFinishedAt) : null,
      promptBuildMs,
      promptChars: actualPrompt.length || expectedPrompt.length,
      rawResponseChars: rawResponse.length,
      reason: result.status === 'ready' ? null : result.reason,
      stateMs,
      transport: agentMetrics?.transport ?? null,
      usage: agentMetrics?.usage ?? null,
      variant: kind,
    },
    summary: `${evalCase.id} attempt ${attempt}: ${result.status}, ${(generationMs / 1000).toFixed(2)}s, first response ${
      firstResponse == null ? 'n/a' : `${(firstResponse.elapsedMs / 1000).toFixed(2)}s`
    }, ${actualPrompt.length || expectedPrompt.length} prompt chars`,
  };
};
