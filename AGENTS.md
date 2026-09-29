# Agency Hub

- Keep AI provider keys, prompts and accounting logic in Hub, not in clients.
- Platform ledger: BIGINT mills ($0.001). AI spend: micro-USD.
  Use constructors from `packages/shared`; respect explicit units in API fields.
- Journal captured platform data in `observations` before parsing; no scheduled
  deletion of captured facts.
- Platform command outbox: at most one attempt per command;
  never auto-retry an indeterminate send.
- Hub platform requests use the egress resolver: Fansly requires the page proxy;
  OFAPI uses vendor-scoped direct egress.
- DB migrations are forward-only.
- After API contract changes, run `pnpm contracts:generate`.
  Clients needing those changes re-vendor via `scripts/vendor-sdk.mjs`.
- `pnpm check` excludes integration tests; they need Docker (Testcontainers).
- CI (repo variable `CI_POOL`: `pc` = owner's self-hosted runners, else GitHub-hosted):
  - Open PRs as Draft; a Draft's red Quality Gate is expected.
  - Run `pnpm check` locally before marking Ready; mark Ready once.
  - With `CI_POOL` not `pc`, a push to a Ready PR runs static checks only and
    the Quality Gate stays red until integration runs. When the PR is final,
    add the label: `gh pr edit <number> --add-label ci:full`.
  - A job queued over 10 minutes on the self-hosted pool means the PC is down;
    tell the owner (they switch pools with `ci-pool`).
  - Never use `[skip ci]`, including in squash messages: every main commit
    must keep a Quality Gate record.
- Do not create or maintain decision/session logs.
