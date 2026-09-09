# Walkthrough evaluations

This suite measures Codiff walkthrough generation on two axes:

1. Performance: repository-state loading, prompt construction, time to first response,
   end-to-end generation, transport, and token usage.
2. Quality: deterministic hunk coverage plus an independent 0-100 judge for factual
   grounding, prioritization, organization, and specificity.

The fixed cases are:

- `small`: `c0adcf7`, one file and two reviewable hunks.
- `focused-small`: `88a977c`, three files and nine reviewable hunks.
- `medium`: `7e71d5f`, 21 files and 67 reviewable hunks.
- `large`: `6354103`, 30 files and 145 reviewable hunks.

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

The enforced comparison rejects a quality drop greater than 10% and a median repository-state
regression greater than 5% with a 3ms noise floor.

Use `--case small` to run one case. The model defaults to the current Codiff
`openAIModel` setting and can be overridden with `--model`.

Generated artifacts stay under ignored `evals/runs/<label>/`. Each attempt contains the
prompt, raw response, normalized walkthrough, timings, phase events, usage, deterministic
metrics, and judge output. When the baseline includes repository-state timing,
`compare.mjs --enforce` also fails if the candidate omits it.
