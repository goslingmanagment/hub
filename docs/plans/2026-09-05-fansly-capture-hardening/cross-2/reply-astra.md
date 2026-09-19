## D1 — **object**: Chromium family for the canary

Use **pinned Chrome Stable through Playwright’s supported `chrome` channel**, headed, sandbox enabled, with a dedicated persistent profile and independently authenticated session. This makes my earlier “ordinary Chromium” choice precise.

The concrete benefit is controlling a **stock vendor browser release through a supported Playwright path**; Playwright cannot control stock Firefox and requires its patched build. Stock Firefox via BiDi changes the controller and introduces another implementation to validate. This is a maintenance and diagnosis benefit, not demonstrated protection from Fansly enforcement. [Playwright browser support](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge).

The assertion that Firefox’s patches are “JS-visible only” is too strong. The pinned v1.60 patch modifies `netwerk/protocol/http/nsHttpChannel.cpp`, `InterceptedHttpChannel.cpp`, and certificate-override code, besides `Navigator.cpp`. That establishes changes below JavaScript; it does **not** establish a different TLS fingerprint under our proposed settings. [Versioned Firefox patch](https://raw.githubusercontent.com/microsoft/playwright/v1.60.0/browser_patches/firefox/patches/bootstrap.diff).

Firefox has the better supplied application-level comparison corpus: the extension declares Gecko ≥142 (`/Users/dmitriy/code/goose/fansly-ext/manifest.json`), and the permitted August HARs show Firefox requests. However, those HARs contain no TLS ClientHello or HTTP/2 SETTINGS/frame capture; they cannot prove transport parity. The owner’s answers §4 also leave model-mobile access unresolved. “Every client on that IP is Firefox” exceeds the evidence.

**The additional browser-family variable is a cost I accept for the stock-release control path.** No supplied evidence shows that mixed browser families on one account/IP increase Fansly enforcement risk. Neither browser has a proven ban-risk advantage.

Proxy authentication is a tie: Playwright 1.60 rejects authenticated SOCKS5 before browser selection ([source](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/browserContext.ts#L786-L789)). Use the resolver-configured per-page tunnel with remote DNS and unchanged end-to-end TLS. Validate the read bridge and mutation blocking offline before the canary. A challenge pauses that profile for recovery; it does not trigger browser-family rotation.

## D5 — **combine**: preserve daily coverage; reduce duplicate attempts first

**Daily is deliberate product behavior, not a hard per-fan SLA.** Stage 16 explicitly chose daily refresh because statistics move slowly (`docs/migration-history/stages/stage-16-fansly-earnings-ppv-streams.md:57`); current policy is 86,400 seconds with `freshnessSlaSeconds: null` (`packages/db/src/repositories/page-sync.ts:279`).

The actual dependencies narrow the claim:

- **Spenders board:** `apps/runtime/src/modules/audience/index.ts:123` reads lifetime/monthly `fan_earnings_stats`. The extension’s sole ranking source is this projection (`/Users/dmitriy/code/goose/fansly-ext/src/background/spenders-service.ts:1`); its tooltip promises approximately hourly-to-daily capture, explicitly allowing older individual rows (`src/content/spenders/spenders-board-controller.ts:51`, same extension repo). A monthly cold-fan policy changes that expectation.
- **Insights:** revenue reads `revenue_mix_daily` and `revenue_month_totals`, not this projection (`packages/db/src/repositories/fansly-insights.ts:1148,1191`). Those consumers impose no freshness requirement on this lane.
- **Agent datasets:** `fan_earnings` remains **planned**, not available (`packages/contracts/src/agent-read-datasets.ts:885`). It supplies no current freshness commitment. This is not a ledger-feed dependency.

Before migration, retain the daily spender walk. The minimal reduction I would ship, **if measured retries justify it**, is resuming a partially completed fan without refetching its successfully captured statistics. Today a monthly-call failure causes the preceding statistics call to repeat (`apps/runtime/src/services/sync/executor-handlers.ts:4434-4509`). Extend the operational checkpoint with page/fan/sweep identity, fixed request window, completed endpoint and durable receipt reference. Resume only the missing endpoint; advance the fan cursor only after both succeed. Invalid/missing proof falls back to capture. This saves duplicate attempts without skipping daily work.

First measure actual attempts, partial-pair failures, per-fan capture ages and ordinary-sweep value changes; projection `observed_at` alone is not proof of an unchanged successful revisit.

Shadow the activity proposal against at least 30 days of normal daily captures, including month rollover: count changed-but-clean fans, missed rank entrants, amount/rank errors and saved calls. Add no comparison traffic. The claimed 85% saving remains unverified. A longer cold-fan interval requires an explicit freshness decision. If later adopted: `(page, fan, dueAt, dirtySeq, capturedSeq)`; seed all spenders, retain failures, and clear only the captured sequence after both durable receipts. Enforce the agreed cold-age ceiling.
