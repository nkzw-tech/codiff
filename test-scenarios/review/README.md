# Review Scenarios

Review Scenarios materialize deterministic Git histories for Codiff review behavior. Scenario
definitions keep repository construction, fixture metadata, and conformance expectations behind
one registry so later review modes can add cases without replacing the harness. Deterministic
conformance covers structure and call topology only; semantic concept coverage belongs to the eval
judge.

`current/` contains current base-to-head review targets. Each scenario README documents the
repository shape it creates; provider mutation coverage belongs to the separate provider-scenario
layer.
