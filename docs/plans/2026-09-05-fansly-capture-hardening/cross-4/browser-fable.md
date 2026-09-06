# Browser dossier (Fable) — objective, both candidates

Tags: **E** = evidence (source cited), **I** = inference. Playwright = v1.60.0.

## A. Firefox

**A1** Playwright build (Juggler): Firefox `release` at a pinned revision + `bootstrap.diff`
(shipped 150.0.2, `browsers.json`). **A2** stock Firefox over BiDi (`moz-firefox` channel).

1. **Network fingerprint.** `bootstrap.diff` (71 files): `netwerk/` hunks add request
   interception and a force-offline flag to `nsHttpChannel`; `security/` only relaxes
   cert overrides; no NSS, HTTP/2 or SOCKS code touched — E (diff). TLS/H2 = stock Firefox
   of that version (H2 order `m,p,a,s` vs Chrome `m,a,s,p`, Akamai paper) — E. Page-IP
   population: chatters' Firefox 153 — E (HARs, owner). A1 lags (150) and Firefox goes
   2-week from 155 (Sept 2026) — E; A2 is the exact release population.

2. **JS-visible surface.** A1 hard-codes `Navigator::Webdriver()` to `return true`
   (`bootstrap.diff`); stock Firefox returns true whenever Marionette or the Remote Agent
   (BiDi) runs (`Navigator.cpp:2322-2344`), no pref gate exists (`dom.webdriver.enabled`
   absent from the tree) — E. NEITHER Firefox path can show `webdriver === false`; only a
   patched build (Camoufox) can. No CDP artefacts (rebrowser-patches: Chrome only) — E.
   Playwright globals (`__playwright__binding__`, `__pwInitScripts`) appear only with init
   scripts/bindings (Kasada write-up) — E; `page.evaluate`-only use avoids them — I. Headed
   Xvfb: software WebGL (`webgl.forbid-software=false`, `playwright.cfg`) → llvmpipe, a
   server tell (castle.io, cside) — E. UA is Linux, truthful. AWS WAF tokens carry "browser
   interrogation, such as indications of automation and browser setting inconsistencies",
   signals unpublished — E (waf-tokens-details).

3. **AWS WAF challenge.** `challenge.js` needs a secure-context browser with JS and
   cookies — E (waf-javascript-api); Firefox runs it unattended. Whether interrogation
   flags `webdriver=true` is unpublished; `TGT_SignalAutomatedBrowser` answers with
   CAPTCHA, not Block, and only when a token exists — E (bot rule group). `TGT_TokenReuseIp*`
   would have hit the old shared-session design, not a per-profile session — I.

4. **Control.** A1: full API (persistent context, `page.route`, `routeWebSocket` since
   1.48, `serviceWorkers:'block'`, `firefoxUserPrefs`) — E. A2: experimental; BiDi cannot
   read bodies, intercept WebSockets, set per-context proxy/headers/preload scripts
   (playwright#32577) — E → default-deny bridge not implementable on A2 today. Loopback
   tunnel required (SOCKS5 auth rejected for all engines, `normalizeProxySettings`) — E;
   HTTP/3 off behind any TCP proxy, both families — E. Memory: 8-process cap, ~18% less
   than Chrome in 2026 benchmarks, Chrome lighter idle — E (weak) → measure. Remote
   screen: Xvfb + VNC only.

5. **Operational risk.** Memory growth in long-lived Playwright Firefox is recurring
   (#4434, #12464, #38864) — E; periodic restarts (profile persists). Build moves only with
   Playwright releases; a new Fansly bundle hits the check-key extractor, not the browser — I.

6. **Verdict.** A1 viable, A2 not yet. Confidence medium. Decisive fact: no CDP artefact
   and stock TLS/H2, at the cost of a permanent `webdriver=true`. Flips if the spike shows
   the WAF interrogation treats `webdriver=true` as automation while Chromium with
   `AutomationControlled` passes.

## B. Chromium family

**B1** Chrome Stable (`chrome` channel, CDP). **B2** Playwright Chromium: unpatched
upstream build (no `browser_patches/chromium` at v1.60 — E; 148.0.7778.96, ahead of
branded Chrome — E, docs).

1. **Network fingerprint.** BoringSSL ClientHello with GREASE and extension shuffling; H2
   `m,a,s,p` — E. Identical to Chrome of that version (B2 = a version the public has not
   received yet — I, minor). Lone Chromium on a Firefox-only IP; no public evidence Fansly
   scores browser family across sessions — I. Chrome goes 2-week from 153 (Sept 2026),
   weekly security refreshes — E.

2. **JS-visible surface.** `webdriver` true under `--enable-automation`, removable
   (`ignoreDefaultArgs`, `--disable-blink-features=AutomationControlled`; MDN, ZenRows) —
   E → the only candidate showing `webdriver === false` unpatched. The CDP `Runtime.enable`
   leak (DataDome, June 2024) was closed in V8 for Chrome M137 (May 2025) — E; other CDP
   side channels "survive", undocumented — E (crawlex). Playwright globals as in A. Xvfb
   WebGL = SwiftShader/ANGLE, server tell — E. Kasada-class detectors weigh UA ↔
   codecs/fonts/GPU consistency — E; a truthful Linux Chrome is consistent — I.

3. **AWS WAF challenge.** Runs unattended; same unpublished interrogation. Under
   `AutomationControlled` it presents fewer automation flags than A1 — I.

4. **Control.** Primary engine: everything in A1 plus CDP screencast (remote view without
   VNC) — E. Same loopback tunnel — E. Memory: per-site renderers; one tab ≈ Firefox,
   lighter idle — E (weak). B1 auto-updates on the host unless pinned — E (docs).

5. **Operational risk.** `--disable-dev-shm-usage` is a default switch (Docker) — E;
   open/close leaks reported (#21079) — E; Chrome auto-update can move a pinned build
   unless the updater is disabled — I.

6. **Verdict.** Viable. Confidence medium. Decisive fact: the only candidate showing
   `webdriver === false` unpatched, on the primary-supported path; cost: a lone Chromium
   on a Firefox-only IP, with no evidence that matters. Flips if the spike shows the WAF
   SDK or Fansly JS probing CDP side channels that A1 lacks.

## Bottom line for the neutral reviewer

A1 and B both pass the network layer; A2 is blocked by BiDi gaps. The difference is
JS-visible: A1 = no CDP, permanent `webdriver=true`; B = `webdriver=false` available,
CDP-driven with the classic leak closed since M137. Neither tell is known to be used by
Fansly today (WAF SDK dormant). Deciding spike: run `challenge.js` in both profiles against
an own AWS WAF test distribution with Bot Control targeted rules and read the
`automated_browser`/`browser_inconsistency` labels.
