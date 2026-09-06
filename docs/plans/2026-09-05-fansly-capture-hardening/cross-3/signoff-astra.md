Object

1. Stage 3: “не слать check для остальных (доказанно принимаемая форма, как прод сегодня)”. This reverses the agreed fail-closed rule. Existing replay acceptance does not validate a changed browser/app identity. Reuse only a successfully validated exact-path check from the same identity/build generation; otherwise pause the unsupported read. Sources: `answers.md:10–19`; `cross-1/reply-astra.md:66–68`.

2. Stage 1c: “уважать полный Retry-After (потолок 24 ч, видимый владельцу)”. A 72-hour server deadline cannot become 24 hours. Cap our fallback backoff, never a longer valid server deadline; preserve it durably. The ceiling recreates the defect in `packages/shared/src/http-client.ts:546` and contradicts settled D4 (`cross-1/reply-astra.md:78`).

3. Acceptance: “снять со allowlist → следующий чанк на undici”. This conflicts with prohibiting both old-bundle reuse and browser-token export. Pause/drain the page and preserve custody; rollback browser code, or separately authorize a dedicated replay identity. Never silently resume the owner's token. Sources: `plans/plan-astra.md:230,310–314`; `packages/fansly/src/adapter.ts:2010`.

4. Stage 1f: “канонизатор транзакций/подписок — полная лента денег”. Completeness relative to earnings corrections is unproved; that projection consumes separate `fan.earnings_observed` snapshots (`apps/runtime/src/services/projections/fan-earnings.ts:52`). Daily coverage remains until shadow evidence and the owner’s freshness decision. Clearing dirty state must compare the captured sequence/cutoff, preserving changes arriving during the two reads (`cross-2/reply-astra.md:25–29`).

5. Stage 2: “`login` (владелец, всё разрешено)” precedes the seven-day login gate and Stage 3 guards. Install/test guards before first live navigation, grant narrow owner-login exceptions, then enter capture mode immediately. Unrestricted native tabs emit delivery acknowledgements; the agreed offline gate must precede live login (`cross-1/reply-astra.md:D3`, `fansly-ui-walk-2026-08-21.har`, bundle offsets ≈622315/631396).

Material corrections:

- “Хаб реплеит личную сессию владельца с второго IP.” Session reuse is confirmed; the owner's browser exit is not (`answers.md:22–46`). Label the second-IP claim conditional.
- “Fansly включила проверку” is a hypothesis, not a diagnosis from two 401/403s (`packages/fansly/src/adapter.ts:2052`).
- “те же `persistRawPayload`” needs receipt/ACK crash tests, stable redelivery identity and spool backpressure before remote cutover; current journal keys include run/fetch identity (`apps/runtime/src/services/sync/shared.ts:146–191`).
- “~29 тыс. запросов/сутки” counts observations, not all attempts/background traffic (`reference/prod-facts-2026-09-05.md:4`).
- “но не TLS” / “снимается префами”: neither assurance was established. Playwright v1.60 Firefox explicitly patches `Navigator::Webdriver()` to return true. Remove unsupported transport-parity/invisibility claims ([versioned patch](https://raw.githubusercontent.com/microsoft/playwright/v1.60.0/browser_patches/firefox/patches/bootstrap.diff)).
