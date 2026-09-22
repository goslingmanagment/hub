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
- Keep unfinished PRs Draft; their red Quality Gate is expected.
  Never use `[skip ci]`, including in squash messages: it can skip production images.
- Do not create or maintain decision/session logs.
