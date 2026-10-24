# fleet-digest — agent notes

Fleet waitlist digest Worker (nightly cron + Monday weekly
rollup cron, token-gated manual `/run`). One file: `src/worker.js`; tests in `src/worker.test.js`
(`bun test`). No test suite beyond that; no build step.

Non-negotiables:

- The digest covers the **America/Toronto** day, computed with the
  timezone-exact helpers in worker.js (DST-tested). D1 timestamps
  are UTC strings; never compare them against local dates directly.
- The scheduled runs send **only when the period had ≥1 new
  confirmed signup** (day for the nightly, Mon–Sun Toronto week
  for the Monday rollup). Manual `/run` always sends (proof path;
  `?mode=weekly&day=<week-end>` for a weekly) and requires
  the `DIGEST_RUN_TOKEN` bearer secret.
- The only D1 write is deleting expired `pending` rows; the only
  KV access is reads. Recipient is fixed:
  `support@webuildstuff.io`; sender `digest@webuildstuff.io`.
- SUPERSEDED 2026-10-24: the owner ordered this Worker merged into repo-review (PR #404); the standalone repo is archived. (Was: this Worker deliberately does NOT live in repo-review — a digest
  there was killed by the owner in 2026-10 (digest issues kept
  filing). Do not move it, and do not add per-signup alerting back
  to the landing Workers: subscriber mail is double opt-in via
  their `mail.js` kit; owner visibility is this digest.
- Deploys are manual wrangler (`bunx wrangler deploy`); verify the
  serving version + cron + workers.dev-disabled via the API after.
