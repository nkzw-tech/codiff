# Generated Provider Mocks

The snapshot revision contains sanitized read-side provider transcripts generated from the current
review manifests in `test-scenarios/review/`. Capture and replay code lands separately so the
large mechanical JSON files remain collapsible in review.

Create or reuse private provider scenarios, record their current-review API routes, and tear them
down:

```sh
node scripts/test-scenarios.mjs create-scenarios --state /tmp/codiff-scenarios.json
node scripts/test-scenarios.mjs record-mocks --state /tmp/codiff-scenarios.json
node scripts/test-scenarios.mjs destroy --state /tmp/codiff-scenarios.json --yes
```

Capture replaces repository identities and scenario commit IDs with symbolic placeholders such as
`{{revision:lifecycle-verification}}`. Replay substitutes the locally materialized revisions and
passes each recorded route through the real current-review provider adapter. The deterministic call
log makes provider access visible without network calls.

Provider submission checks remain opt-in live tests. Ordinary walkthrough evaluation only replays
the local transcripts and never creates or updates a provider review.
