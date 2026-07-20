import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { evaluateScenarioConformance } from '../../test-scenarios/conformance.mjs';
import { materializeReviewScenario, reviewScenarios } from '../../test-scenarios/review/index.mjs';
import { getWalkthroughMetrics, nowMs, readJson, roundMs, writeJson } from '../lib.mjs';
import { loadGitHubScenarioMock, loadGitLabScenarioMock } from '../provider-mock-loader.mjs';
import {
  buildEvalShareManifest,
  buildScenarioReviewTarget,
  computeFixtureDigest,
} from '../review-artifacts.mjs';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

export const kind = 'review-scenario';

export const normalizeScenarioFixtureRevisions = (value, revisions) => {
  if (typeof value === 'string') {
    return Object.entries(revisions)
      .toSorted(([, left], [, right]) => right.length - left.length)
      .reduce(
        (normalized, [name, revision]) =>
          normalized
            .replaceAll(revision, `{{revision:${name}}}`)
            .replaceAll(revision.slice(0, 8), `{{shortRevision:${name}}}`),
        value,
      );
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeScenarioFixtureRevisions(item, revisions));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeScenarioFixtureRevisions(item, revisions),
      ]),
    );
  }
  return value;
};

const semanticFixture = (evalCase, definition, providerTranscripts, revisions, state) => ({
  case: evalCase.id,
  description: definition.description,
  expectation: definition.walkthroughExpectations,
  files: state.files.map((file) => ({
    path: file.path,
    sections: file.sections.map((section) => ({ kind: section.kind, patch: section.patch })),
    status: file.status,
  })),
  providerTranscripts: normalizeScenarioFixtureRevisions(providerTranscripts, revisions),
  rubric: evalCase.rubric,
  scenario: definition.id,
});

const removeDirectory = async (directory) => {
  await rm(directory, { force: true, recursive: true });
};

export const buildJudgePrompt = async ({ attemptDir, evalCase, walkthrough }) => {
  const [contract, scenario, state] = await Promise.all([
    readJson(join(attemptDir, 'contract.json')),
    readJson(join(attemptDir, 'scenario.json')),
    readJson(join(attemptDir, 'inputs', 'review-state.json')),
  ]);
  return `You are judging a Codiff current-review scenario walkthrough. The recorded scenario inputs below are the complete source of truth. Do not run git commands or infer behavior outside these inputs.

Scenario rubric:
${evalCase.rubric.map((item) => `- ${item}`).join('\n')}

Scenario definition:
${JSON.stringify(scenario)}

Scenario state:
${JSON.stringify(state)}

Deterministic contract result:
${JSON.stringify(contract)}

Candidate walkthrough:
${walkthrough}

Scoring:
- factualGrounding (0-35): statements match the selected current review; no invented behavior, tests, risks, intent, or findings.
- prioritization (0-30): the walkthrough covers the most consequential behavior in a useful order.
- organization (0-20): conceptual chapters follow the declared current-review structure.
- specificity (0-15): prose names concrete symbols, contracts, and interactions.
- total must equal the four component scores.

Treat the deterministic contract as authoritative for structural conformance. Be strict and consistent, and put material factual or coverage failures in majorErrors.`;
};

export const runAttempt = async ({
  attempt,
  attemptDir,
  effort,
  evalCase,
  model,
  prepareOnly,
  root,
}) => {
  const definition = reviewScenarios[evalCase.scenario];
  if (!definition) {
    throw new Error(`Unknown review scenario ${evalCase.scenario}.`);
  }
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'codiff-eval-scenario-'));
  const stateStarted = nowMs();
  const runGit = async (args) =>
    (await execFileAsync('git', args, { cwd: repositoryRoot })).stdout.trim();
  try {
    const materialized = await materializeReviewScenario({
      root,
      runGit,
      scenarioId: evalCase.scenario,
    });
    const { getAgent } = require('../../electron/agent.cjs');
    const { readRepositoryState } = require('../../electron/git-state.cjs');
    const {
      buildNarrativeWalkthroughPrompt,
      readNarrativeWalkthrough,
    } = require('../../electron/narrative-walkthrough.cjs');
    const baseState = await readRepositoryState(repositoryRoot, {
      base: 'main',
      head: 'feature/test-scenario',
      symmetric: false,
      type: 'range',
    });
    const headSha = Object.values(materialized.revisions).at(-1);
    if (typeof headSha !== 'string' || !headSha) {
      throw new Error(`Review scenario ${definition.id} has no final head revision.`);
    }
    const state = {
      ...baseState,
      source: {
        description: `${definition.description}

Walkthrough evaluation expectation: use ${definition.walkthroughExpectations.reviewStructure} structure with at least ${definition.walkthroughExpectations.minimumChapters} conceptual chapters and ${definition.walkthroughExpectations.minimumStops} stops. Treat this as reviewer-path guidance, not proof of behavior.`,
        headSha,
        provider: 'github',
        title: `Scenario: ${definition.id}`,
        type: 'pull-request',
        url: `https://provider.example.test/codiff/${definition.id}/review/1`,
      },
    };
    const providerTranscripts = {
      github: (
        await loadGitHubScenarioMock({
          owner: 'fixture',
          revisions: materialized.revisions,
          scenarioId: evalCase.scenario,
        })
      ).transcript,
      gitlab: (
        await loadGitLabScenarioMock({
          projectPath: `fixture/${evalCase.scenario}`,
          revisions: materialized.revisions,
          scenarioId: evalCase.scenario,
        })
      ).transcript,
    };
    const stateMs = roundMs(nowMs() - stateStarted);
    const promptStarted = nowMs();
    const expectedPrompt = await buildNarrativeWalkthroughPrompt(state, null, 'Codex');
    const promptBuildMs = roundMs(nowMs() - promptStarted);
    const fixtureDigest = computeFixtureDigest(
      semanticFixture(evalCase, definition, providerTranscripts, materialized.revisions, state),
    );
    await writeFile(join(attemptDir, 'prompt.txt'), expectedPrompt);
    await writeJson(join(attemptDir, 'inputs', 'provider-transcripts.json'), providerTranscripts);
    await writeJson(join(attemptDir, 'inputs', 'review-state.json'), {
      branch: state.branch,
      files: state.files,
      source: state.source,
    });
    await writeJson(join(attemptDir, 'scenario.json'), {
      description: definition.description,
      expectation: definition.walkthroughExpectations,
      revisions: materialized.revisions,
      scenario: definition.id,
    });

    if (prepareOnly) {
      return {
        meta: {
          actualCallTopology: { whole: 0 },
          agentMs: null,
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
          scenario: evalCase.scenario,
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
        ...(baseAgent ? { fallbackModel: baseAgent.fallbackModel } : {}),
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
    const generationMs = roundMs(generationFinished - generationStarted);
    const firstResponse = phases.find((event) => event.phase === 'response-received');
    const reviewScope = {
      comparisonScope: definition.walkthroughExpectations.comparisonScope,
      reviewStructure: definition.walkthroughExpectations.reviewStructure,
    };
    const contract =
      result.status === 'ready'
        ? evaluateScenarioConformance({
            callTopology: { whole: 1 },
            expectation: definition.walkthroughExpectations,
            reviewScope,
            walkthrough: result.walkthrough,
          })
        : {
            chapterCount: 0,
            failures: [result.reason ?? 'Walkthrough generation failed.'],
            pass: false,
            stopCount: 0,
          };
    await writeJson(join(attemptDir, 'contract.json'), {
      failures: contract.failures,
      metrics: { chapterCount: contract.chapterCount, stopCount: contract.stopCount },
      pass: contract.pass,
    });
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
          artifactId: `scenario/${evalCase.scenario}`,
          reviewScope: {
            kind: 'merge-request',
            structure: definition.walkthroughExpectations.reviewStructure,
          },
          state,
          walkthrough: result.walkthrough,
        }),
      );
      await writeJson(
        join(attemptDir, 'review-target.json'),
        buildScenarioReviewTarget({ materialized, scenarioId: evalCase.scenario }),
      );
    }

    const exitStatus = result.status;
    return {
      meta: {
        actualCallTopology: { whole: 1 },
        agentMs:
          agentStartedAt && agentFinishedAt ? roundMs(agentFinishedAt - agentStartedAt) : null,
        effort,
        exitStatus,
        firstResponseMs: firstResponse?.elapsedMs ?? null,
        fixtureDigest,
        generationMs,
        metrics:
          result.status === 'ready' ? getWalkthroughMetrics(state, result.walkthrough) : null,
        model,
        modelCalls: 1,
        phases,
        postprocessMs: agentFinishedAt ? roundMs(generationFinished - agentFinishedAt) : null,
        promptBuildMs,
        promptChars: actualPrompt.length || expectedPrompt.length,
        rawResponseChars: rawResponse.length,
        reason: result.status === 'ready' ? null : result.reason,
        scenario: evalCase.scenario,
        stateMs,
        transport: agentMetrics?.transport ?? null,
        usage: agentMetrics?.usage ?? null,
        variant: kind,
      },
      summary: `${evalCase.id} attempt ${attempt}: ${exitStatus}, scenario ${evalCase.scenario}`,
    };
  } finally {
    await removeDirectory(repositoryRoot);
  }
};
