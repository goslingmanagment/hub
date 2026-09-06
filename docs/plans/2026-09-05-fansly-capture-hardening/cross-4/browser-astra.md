# Browser dossier — 2026-09-06

**E = evidence; I = inference. Scope: Playwright 1.60, Linux x64. Shared findings apply to all four candidates.**

**Population/network.** E: Chatters use Firefox/extensions through each page’s proxy; six HARs show Firefox 153 ([owner](../answers.md), [prompt](prompt.md)). I: HARs cannot establish ClientHello/JA3/JA4 or HTTP/2 SETTINGS/pseudo-header equivalence; compare packets against the same stock version. E: [Cloudflare](https://blog.cloudflare.com/ja4-signals/) evaluates fingerprints with population behaviour.

**Host/detection.** E: [AWS](https://docs.aws.amazon.com/waf/latest/developerguide/waf-tokens-details.html) documents automation/settings inconsistencies and mouse/key/form interaction; its undisclosed probe inventory does not establish specific webdriver/CDP/WebGL/canvas/font/Xvfb checks. [Kasada](https://www.kasada.io/behind-the-scenes-defensive-security-kasada-v2/) describes client sensors plus behavioural anomalies. I: Neither proves a Fansly browser ranking. Headed [Xvfb](https://playwright.dev/docs/ci#running-headed) plus [noVNC](https://github.com/novnc/noVNC#server-requirements) supports remote intervention; software rendering/WebGL/canvas, Linux fonts and screen geometry can contradict a Mac UA; a Linux UA still needs consistent graphics ([fingerprinting](https://developer.mozilla.org/en-US/docs/Glossary/Fingerprinting), [renderer flags](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/chromium.ts)).

**W — challenge.** E: Captured app wires the SDK; activation was unobserved ([capture analysis](../plans/plan-astra.md)). I: All four can execute `challenge.js` and attempt unattended token acquisition; acceptance remains unproven. E: Silent Challenge differs from human CAPTCHA ([AWS](https://aws.amazon.com/blogs/networking-and-content-delivery/protect-against-bots-with-aws-waf-challenge-and-captcha-actions/)); getToken can time out after two seconds; domain/cookie mismatches can defeat acceptance ([API](https://docs.aws.amazon.com/waf/latest/developerguide/waf-js-challenge-api-get-token.html)). I: Blocked SDK/probe traffic also defeats acquisition.

**C — controls.** E: v1.60 rejects authenticated SOCKS5; service-worker blocking replaces registration in JavaScript ([source](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/browserContext.ts)). WebSocket routing also injects JavaScript ([source](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/dispatchers/webSocketRouteDispatcher.ts)). I: All need per-page loopback tunnels; `page.route` needs worker/existing-service-worker tests; injected hooks add JS-visible artefacts. Measure WS/WSS, DNS, IPv6 and QUIC leakage during tunnel failure; enforce egress outside browsers ([proxy scope](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)).

**O — operations.** E: Historical [Firefox headed OOM](https://github.com/microsoft/playwright/issues/4434) and [Chromium-driver growth](https://github.com/microsoft/playwright/issues/15400) are incomparable; the latter’s 400 MB/20 minutes concerns Node. I: No defensible per-profile sizing or corruption ranking follows. Measure whole-process-tree PSS during a 72-hour eight-profile soak. Use exclusive profiles, cold backups and upgrade canaries ([persistence](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)); bundle changes can invalidate the application bridge/check/WAF assumptions, requiring pause/revalidation ([prior contract](../cross-3/signoff-astra.md)).

## A1 — patched Firefox/Juggler

| Row | Finding |
|---|---|
| 1 Network | E: Pinned Firefox 150.0.2; patches touch HTTP interception/certificate handling ([versions](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/browsers.json), [patch](https://github.com/microsoft/playwright/blob/v1.60.0/browser_patches/firefox/patches/bootstrap.diff)). I: Stock 150 TLS/h2 equivalence unmeasured; older than observed 153. |
| 2 JS | E: [Patch](https://github.com/microsoft/playwright/blob/v1.60.0/browser_patches/firefox/patches/bootstrap.diff) hardcodes webdriver=true, headed too. I: No preference removes that branch; JavaScript masking changes appearance. E: Juggler, not CDP ([driver](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/firefox/firefox.ts)). |
| 3 WAF | I: W applies; Juggler supplies no demonstrated exemption. [AWS](https://docs.aws.amazon.com/waf/latest/developerguide/waf-tokens-details.html). |
| 4 Control | E: Supported persistent Juggler path; context proxy sets remote-DNS/no-fallback flags ([network](https://github.com/microsoft/playwright/blob/v1.60.0/browser_patches/firefox/juggler/NetworkObserver.js)). I: C still required. |
| 5 Risk | I: O applies; upgrading Playwright must refresh its Firefox fork/pin ([versions](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/browsers.json)). |
| 6 Verdict | I: Viable, medium confidence; decisive: supported Firefox control. Flip: any forbidden egress in the C fixture ([driver](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/firefox/firefox.ts)). |

## A2 — stock Firefox/ESR, BiDi

| Row | Finding |
|---|---|
| 1 Network | E: Stock executable, automation preferences ([launcher](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/bidi/bidiFirefox.ts)). I: Same-version Gecko TLS/h2 baseline expected; ESR need not resemble 153. |
| 2 JS | E: Active RemoteAgent sets webdriver=true ([Mozilla](https://github.com/mozilla-firefox/firefox/blob/main/dom/base/Navigator.cpp)); BiDi uses [realms](https://w3c.github.io/webdriver-bidi/#command-script-getRealms), not CDP. I: No supported off-switch established ([BiDi](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection)). |
| 3 WAF | I: W applies; stock branding cannot guarantee tokens. [AWS](https://docs.aws.amazon.com/waf/latest/developerguide/waf-tokens-details.html). |
| 4 Control | E: [`moz-firefox` persistence](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/firefox/firefox.ts) exists; Mozilla describes PW integration as [experimental](https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi/Milestone_19). HTTP proxy maps only httpProxy ([source](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/bidi/bidiBrowser.ts)); intercepted preflights are synthesized ([source](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/bidi/bidiNetworkManager.ts)). I: HTTPS/WSS/ESR parity needs testing; other clients need equivalent guards. |
| 5 Risk | E: [ESR](https://support.mozilla.org/en-US/kb/firefox-esr-release-cycle) backports security, not general enhancements; [Firefox 155](https://blog.mozilla.org/sumo/2026/08/19/firefox-new-release-cadence-and-what-to-expect/) started fortnightly releases September 1. I: O applies; ESR commands may lag. |
| 6 Verdict | I: Conditional, medium confidence; decisive: experimental interception path. Flip to viable: 100% C-fixture conformance on selected stock/ESR/client ([milestone](https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi/Milestone_19)). |

## B1 — Google Chrome Stable/CDP

| Row | Finding |
|---|---|
| 1 Network | E: Supported stock channel ([PW](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)). I: Same-version TLS/h2 baseline expected; flags need packet comparison; differs from Firefox population. |
| 2 JS | E: Debugging-pipe/headless enable webdriver ([Chromium](https://chromium.googlesource.com/chromium/src/+/148.0.7778.96/content/child/runtime_features.cc)); flag can suppress it ([DataDome 2024](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/)). Runtime.enable/context machinery persists ([PW](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crPage.ts)). [Rebrowser](https://github.com/rebrowser/rebrowser-patches) tests older PW; [Castle 2025](https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/) reports V8 broke the classic stack-getter detector. |
| 3 WAF | I: W applies; neither CDP detection nor token rejection is established here. [AWS](https://docs.aws.amazon.com/waf/latest/developerguide/waf-tokens-details.html). |
| 4 Control | E: Persistent supported channel; TCP-only SOCKS; proxy DNS/WS selection documented ([Chromium](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)). I: C applies; Stable/PW upgrades need joint certification. |
| 5 Risk | E: [Chrome 153](https://developer.chrome.com/blog/chrome-two-week-release) begins fortnightly releases September 8. I: O applies; independent updates can cause compatibility drift. |
| 6 Verdict | I: Viable, medium confidence; decisive: supported stock control. Flip: failed profile recovery during O’s upgrade/soak fixture ([persistence](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)). |

## B2 — Playwright bundled Chromium

| Row | Finding |
|---|---|
| 1 Network | E: v1.60 x64 bundles Chrome for Testing 148 ([ARM64 exception](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/registry/index.ts)); [build notes](https://github.com/microsoft/playwright/blob/v1.60.0/docs/src/release-notes-js.md) changed distribution in 1.57 ([pin](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/browsers.json)). I: No basis for claiming a bespoke patched TLS stack; stock 148 TLS/h2 equality unmeasured. |
| 2 JS | E: Same CDP surface as B1; default headless uses separate headless-shell ([launcher](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/chromium.ts)). I: Headed removes that difference, not automation. |
| 3 WAF | I: W applies; CfT offers no documented acceptance advantage. [AWS](https://docs.aws.amazon.com/waf/latest/developerguide/waf-tokens-details.html). |
| 4 Control | E: Supported bundled/persistent path; [CfT](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing) disables auto-update. I: C/B1 proxy findings apply; upgrade browser with PW. |
| 5 Risk | I: O applies; reproducibility trades against stale security/features/fingerprints ([CfT](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)). |
| 6 Verdict | I: Viable, medium confidence; decisive: reproducible browser/controller pair. Flip: repeatable automation-only TLS/h2 divergence from stock 148 in controlled packet capture ([CfT](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)). |
