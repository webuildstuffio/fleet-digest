# fleet-digest — ARCHIVED, moved to repo-review

**This repo was merged into the repo tracker on 2026-10-24 (owner
order) and archived.** Do not work here.

The fleet waitlist digest Worker now lives at
[`workers/fleet-digest/`](https://github.com/webuildstuffio/repo-review/tree/main/workers/fleet-digest)
in **webuildstuffio/repo-review** — code, tests, wrangler config
and the deploy flow all moved there (PR
[repo-review#404](https://github.com/webuildstuffio/repo-review/pull/404)).

The deployed Worker is unaffected: same name (`fleet-digest`),
same D1/KV/email bindings, same crons (`15 5 * * *` daily +
`15 5 * * 1` Monday weekly, America/Toronto windows). Deploys now
run from the repo-review copy.

Issues moved too: the one open issue (redundant-tests audit) was
transferred to
[repo-review#405](https://github.com/webuildstuffio/repo-review/issues/405).
