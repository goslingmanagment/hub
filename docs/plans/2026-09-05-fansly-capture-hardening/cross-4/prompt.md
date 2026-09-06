# Browser dossier round — objective research, both browsers

The owner has accepted the merged plan except the browser choice and wants each planner
to research and write an OBJECTIVE dossier on BOTH candidates before he decides. Do not
argue for your earlier pick; write as if briefing a neutral reviewer. Public web research
is expected (vendor docs, source, anti-bot literature, issue trackers); cite every claim.
Mark each claim evidence / inference. Read-only; no Fansly or production calls.

Candidates (cover every row for each):

A. **Firefox** — (A1) Playwright's patched Firefox build driven over Juggler; (A2) stock
   Firefox / ESR driven over WebDriver BiDi (Playwright `moz-firefox` channel or another
   BiDi client).
B. **Chromium family** — (B1) Google Chrome Stable via Playwright's `chrome` channel
   over CDP; (B2) Playwright's bundled Chromium.

For each candidate, one compact section with these rows:

1. **Network-level fingerprint vs the real population.** TLS ClientHello (JA3/JA4) and
   HTTP/2 SETTINGS/pseudo-header order compared with the stock release of the same
   family; whether the Playwright patches touch the network stack (check the versioned
   patch files for v1.60: `browser_patches/firefox/patches/bootstrap.diff` and the
   Chromium build notes); what the page IP's other clients are (owner: chatters on
   Firefox with the extension; the six HARs are Firefox 153).
2. **JS-visible automation surface.** `navigator.webdriver` (what the patch does, can it
   be turned off, and what stock BiDi/CDP set), CDP `Runtime.enable` / execution-context
   artefacts and what public anti-bot research says about them (rebrowser-patches,
   Kasada/DataDome/Cloudflare/AWS WAF Bot Control public write-ups), headless vs headed,
   Xvfb tells, WebGL/canvas/fonts consistency on a Linux server with a "Mac" or "Linux"
   UA. Say which of these AWS WAF's challenge/token SDK is publicly documented to
   collect.
3. **Behaviour under an AWS WAF challenge** (the app has the SDK wired, dormant): can
   each candidate run `challenge.js` and obtain a token unattended; what fails.
4. **Control and maintenance.** Supported Playwright paths and what is experimental;
   persistent profiles; proxy: per-page loopback tunnel required either way (Playwright
   1.60 rejects authenticated SOCKS5) — any difference in how each browser honours a
   context proxy for WebSocket/DNS/QUIC; `page.route`/`routeWebSocket`/service-worker
   blocking parity; remote screen options; memory per profile (public numbers); release
   cadence and how a pinned build ages versus the population.
5. **Operational risk.** Crash/leak history in long-running headed sessions; profile
   corruption; upgrade path; what breaks if Fansly ships a new bundle.
6. **Verdict for this deployment**, with a confidence level and the single decisive
   fact, and the one measurement in the build-phase spike that would flip it.

≤ 900 words total. Write to the output path given in the launch message.
