# Cross-exchange round 2 — reply (Fable)

## D1 — Firefox vs Chromium: **combine; final: Firefox for the canary, chosen once**

Conceded to the Chromium argument: "indistinguishable from one more chatter" was
unsupported — the defensible requirement is consistency WITHIN the kernel's own session
(one device id, one IP, one build, one header/TLS shape), not a browser-family monopoly on
the IP. No public or captured evidence shows Fansly scoring browser family across an
account's sessions (`/sessions` records IP, geo, last-use; nothing about UA). So a lone
Chromium on a Firefox-only page IP is a soft, unmeasurable cost, and I will not sell it as
more. Also verified: playwright-core 1.60 `normalizeProxySettings` throws "Browser does not
support socks5 proxy authentication" for every engine (`coreBundle.js:46988-47006`), so the
per-page loopback tunnel from the resolver's decrypted proxy is required regardless. And
agreed: no ladder after a rejection — decide in the spike, pin, and change only if the read
bridge or a measured constraint forces it.

Why Firefox still wins the tie, with the one concrete benefit Chromium lacks: automation
protocol exposure. Playwright drives Chromium over CDP, whose `Runtime.enable` side
effects are the most-fingerprinted automation artefact in current anti-bot JS (public:
the rebrowser-patches project exists to hide exactly that in Playwright/Puppeteer);
Firefox is driven over Juggler, or over WebDriver BiDi through the stock `moz-firefox`
channel that Playwright 1.60 ships (`coreBundle.js:28955-28965`), leaving no CDP artefact.
Both engines can drop `navigator.webdriver` (`firefoxUserPrefs`, `coreBundle.js:43823-43829`;
`--disable-blink-features=AutomationControlled`, `:66969`), so that is a wash. This
benefit is dormant today (no challenge script runs, bundle WAF wiring inactive) and
matters only if Fansly enables one; it is the only detection-relevant difference either
way, so it decides the tie. Secondary, soft: the bundled Firefox is 150.0.2
(`browsers.json`), close to the observed population's 153.

Chromium's concrete advantages are operational (primary Playwright engine, CDP screencast
for a remote view) and real; the remote screen is Xvfb/VNC either way, so they do not
change capture safety. Final: Firefox, pinned; Chromium only if the spike's bridge or
lock-down fails on Firefox, decided before the canary, once.

## D5 — `fan_earnings`: **combine; measure first, then ship a durable due/dirty model**

(a) Not a product commitment. The only product consumer is the extension's spenders board
via `GET /pages/:label/top-spenders` (`modules/audience/index.ts:127-137`), which reads
`fan_earnings_stats` ranked by lifetime/monthly gross and returns `builtAt` = max
`observed_at` (`message-archive.ts:1586-1640`); the extension shows that timestamp as
"newest-projection freshness" (E30) and caches 10 min. Agent datasets keep `fan_earnings` planned only
(`agent-read-datasets.ts:865-886`); nothing else reads it. The
daily walk of every spender is the lane's design (Stage 16, decisions #76/#78: replace the
board's ~150-call rebuild), not a stated freshness promise; the owner was never asked.

The objection to a silent predicate is right (`executor-handlers.ts:4419-4432, 4480-4512`:
single keyset, contiguous-prefix cursor). The "renewals need not coincide with chat" point
is answered by a different feed: every money movement — tips,
renewals, PPV, reversals, chargebacks — lands in the hourly `transactions` lane as a
transaction row with a fan id; that is a complete dirty feed for "this fan's aggregate may
have changed", stronger than chat activity. Provider-side corrections without a
transaction are what the periodic revisit is for.

(b) Minimal safe path: ship NOTHING to this lane before the report. The report (stage 0,
read-only): per page, spender count N, spenders with a transaction in the last 24 h / 7 d /
30 d. Expected daily visits under the model = daily-active spenders + N/revisit-days; the
−85% is a hypothesis until this runs. Then the model, behind a live key: durable columns on
`page_fans` — `earnings_dirty_at` (set by the transactions canonicalizer/projection and by
subscription events), `earnings_visited_at`, `earnings_due_at` (= visited + revisit days,
owner-set, default 30, floor 7). The walk selects dirty ∪ due, ordered by fan id inside
that set; flags clear only after BOTH responses are journaled; a fan-scoped rejection
stops the walk exactly as today, so due work is never jumped. Active spenders get fresher
(read within the next run after money moved); only fans with no money movement wait up
to the revisit ceiling. Acceptance: no spender with a transaction older than one lane run
left unvisited; no spender unvisited beyond `revisit-days + 1`.
