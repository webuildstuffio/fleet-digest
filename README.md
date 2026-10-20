# fleet-digest

One nightly email with the day's confirmed waitlist signups across
the fleet's coming-soon sites — the replacement for per-signup
owner alert emails (owner order 2026-10-21, alongside the double
opt-in rollout).

## How it works

- Cron `15 5 * * *` UTC — just after Toronto midnight year-round.
  Each run reports the most recently completed **America/Toronto**
  day: per site, the newly confirmed addresses + positions, how
  many signups are still pending confirmation, and a fleet total.
- Sources: the three landing D1s (`PL_DB` playlist.rest, `PW_DB`
  powerful.build, `AG_DB` api.gripe — `status='confirmed'` rows by
  `confirmed_at` in the window) and the anywrapped KV (`AW_KV` —
  `wl:` records by their stored `ts`).
- The run also deletes expired pendings from the D1s (unconfirmed
  signups live 48 h); KV pendings expire by TTL on their own.
- **Sent only when at least one new confirmed signup exists** —
  quiet days send nothing. From `digest@webuildstuff.io` (domain
  onboarded to Email Sending) to `support@webuildstuff.io`
  (verified destination; routes to the owner's inbox).

## Manual run

`POST /run` with `Authorization: Bearer <DIGEST_RUN_TOKEN>`:

- `?day=YYYY-MM-DD` — that Toronto day; `?day=today` or no param —
  today so far. Manual runs always send (this is the proof path).

## Deploy

Manual, wrangler (canonical config is `wrangler.toml`):

```sh
bun install
bun test
bunx wrangler deploy
bunx wrangler secret put DIGEST_RUN_TOKEN   # once
```

After any deploy, verify via the Workers API that the serving
version is at 100%, the cron trigger exists, and workers.dev is
disabled.
