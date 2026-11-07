/**
 * Люди and Человек — the data layer (spec §4.3, §4.4). Owned by the Люди screen.
 *
 * Future contract (phase 2): `teamPeopleSummary` — all people of the period in
 * one request (status, sales and Δ, $/h and Δ, reply median, unanswered at end,
 * AI share, AI spend, shifts) instead of 1+N; unknown `userId` → 404.
 *
 * Phase 1 adapter:
 *   - `teamChatterStats` { days, userId? } — a person's numbers (CHECK
 *     `stats.user.userId` against the asked id: Hub answers an unknown id with the FIRST person);
 *   - `teamShiftSales`, `teamChatterNumbers` — shifts and per-shift numbers;
 *   - `adminUsers` (owner) — everyone with access, their state and pages.
 * The «Доступ» tab renders <PersonAccessPanel userId variant="page" /> from
 * src/shared/PersonAccessPanel.tsx (built by the «Доступ» screen).
 * Query keys start with "people".
 */
export {};
