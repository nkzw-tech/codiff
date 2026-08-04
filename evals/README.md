# Walkthrough evaluations

This suite measures Codiff walkthrough generation on two axes:

1. Performance: repository-state loading, prompt construction, time to first response,
   end-to-end generation, transport, and token usage.
2. Quality: deterministic hunk coverage plus an independent 0-100 judge for factual
   grounding, prioritization, organization, and specificity.

The baseline cases are:

- `small`: `c0adcf7`, one file and two reviewable hunks.
- `medium`: `7e71d5f`, 21 files and 67 reviewable hunks.
- `large`: `6354103`, 30 files and 145 reviewable hunks.

Two deterministic current-review cases reuse the scenario harness:

- `scenario-unstructured-commits`: independently motivated changes shown as one current review.
- `scenario-current-commit-stack`: an intentional stack shown as one current review.

Run the production Codex path twice per case, judge it, and report it:

```sh
pnpm eval:walkthrough baseline --repetitions 2
node evals/judge.mjs baseline
node evals/report.mjs baseline
```

Run a candidate with a different reasoning effort or model:

```sh
pnpm eval:walkthrough low-effort --repetitions 2 --effort low
node evals/judge.mjs low-effort
node evals/report.mjs low-effort
node evals/compare.mjs baseline low-effort --enforce
```

The enforced comparison requires identical case, fixture, and variant identities. It rejects a
quality drop greater than 10%, a failed deterministic contract, and a median repository-state
regression greater than 5% with a 3ms noise floor.

Use `--case small` to run one case, `--prepare-only` to materialize deterministic inputs without a
model call, and `--suite all` to include every registered case kind. The model defaults to the
current Codiff `openAIModel` setting and can be overridden with `--model`.

Prepare the current-review cases without contacting a model:

```sh
pnpm eval:walkthrough current-review-inputs --suite review-scenario --prepare-only
```

## Extending the suite

Each case names a module under `evals/adapters/`. An adapter exports its case `kind`, `runAttempt()`,
and `buildJudgePrompt()`. Feature-specific suites add adapters and cases without changing the
runner or judge. Every attempt writes common metadata with stable fixture and variant identities;
adapters may also write `contract.json` when they have deterministic conformance evidence.

Generated artifacts stay under ignored `evals/runs/<label>/`. A ready attempt contains its case,
prompt, raw response, normalized walkthrough, portable share manifest, timings, phase events,
usage, deterministic metrics, and judge output. Scenario-style adapters can additionally persist
reproducible inputs and a `review-target.json` using the shared artifact contract.
