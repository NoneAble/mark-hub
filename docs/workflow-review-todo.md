# Workflow Review TODO

<!-- Managed by pi-trio-workflow. A later workflow pass may replace this file. -->

- Review mode: balanced (适中)
- Source run: 20260713T120642Z-cfb44cd7
- Final review round: 4

These items were explicitly classified as non-blocking for this review mode.

## TODO-CF-TYPES-001

- Category: suggestion
- First seen: round 4
- Last confirmed: round 4

Generate the Worker Env type from the production Wrangler configuration and replace the hand-written interface in apps/worker/src/index.ts so binding types remain synchronized.

## TODO-CF-WRANGLER-001

- Category: suggestion
- First seen: round 2
- Last confirmed: round 4

Upgrade apps/worker from Wrangler 3.114.17 to a supported 4.x release and refresh compatibility_date after validating the local D1/runtime harness; the executed Worker suite emitted the out-of-date warning.
