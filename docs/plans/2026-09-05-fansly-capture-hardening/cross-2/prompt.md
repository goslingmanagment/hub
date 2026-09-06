# Cross-exchange round 2 — two remaining forks

Round 1 converged on D2, D3, D4, D6, D7 and D8 (measure in the spike). Two points still
split. Read the other side's round-1 argument (quoted, anonymized) and give a FINAL
position on each in ≤ 350 words: agree / object / combine, with the decisive reason.
Same rules: read-only, no Fansly/production calls, cite code or public sources, write to
the output path given in the launch message.

## D1 — Firefox vs Chromium for the page profile

Argument for Firefox (another planner): "Every other client on a page IP is Firefox — the
chatters' Firefox with the extension (manifest is Firefox-only, gecko ≥ 142) and the six
HARs the header work was built from. A lone Chromium on that IP is not a bot signal by
itself, but it is one more distinct device class on an IP that should look like an agency
team on Firefox, and it throws away the only baseline we have for header/TLS parity (all
HARs are Firefox). Playwright's Firefox patches are JS-visible only (`navigator.webdriver`),
same as Playwright's Chromium; the network stack (Gecko/NSS TLS, HTTP/2, header order) is
stock. Proxy auth is solved for either browser by a per-page loopback credential-injecting
forwarder, so the tooling argument disappears; the tie-breaker is parity with the
observed population. Pin the build; advertise whatever it actually is."

Argument for Chromium (another planner): "'Indistinguishable from one more chatter' is
unsupported: sharing a browser family does not establish matching builds, preferences,
extensions, TLS/H2 behavior or JS-visible automation state. The kernel's profile is a NEW,
independently authenticated session, not the copied owner's session; no supplied evidence
establishes a Fansly rule requiring every session on an account/IP to use the same browser
family — consistency within a session is the defensible requirement, an account-wide
Firefox monopoly is not. Playwright v1.60 `normalizeProxySettings` rejects SOCKS5 with
username/password for any browser, so use a resolver-configured local CONNECT-to-SOCKS
tunnel either way. Do not climb an ESR/BiDi/Camoufox ladder after a rejection — each step
adds an identity variable; reconsider Firefox only if the read bridge or a measured
constraint favors it."

Decide: which browser for the canary, and is a lone Chromium session on a Firefox-only
page IP a cost worth paying for anything concrete? Name the concrete benefit of your
choice that the other browser lacks, if any. If none, say so.

## D5 — `fan_earnings` lane (≈ 20% of traffic: two statistics calls per spender per day)

Argument for change-driven revisit (another planner): "The lane calls two statistics routes
for EVERY known spender daily (`executor-handlers.ts:4434-4449`; lilly-2 ≈ 2 010/day ≈ 18%
of the page), which the app does only when a fan's card is opened. Visit a fan only when
it had activity since its last visit (transaction, message head move, subscription — all
already in projections) or when its last visit is older than 30 days (`fanslyFanEarningsRevisitDays`),
so every fan is read at least monthly. Expected −85% of the lane."

Argument against, as specified (another planner): "The lane is already spender-scoped: it
keyset-walks fans with positive recorded spend (`executor-handlers.ts:4369-4509`) and the
cursor advances only through a contiguous successful prefix; an activity filter cannot be
a predicate that silently jumps the cursor past failed/due work — it needs a durable
due/dirty model. Renewals, adjustments and provider corrections need not coincide with
chat activity; the supplied evidence does not prove a complete dirty feed. The owner
accepted DM lag, not a 30-day staleness change to top-spender/financial data. The −85% is
unmeasured: build a candidate/coverage report first."

Decide: (a) is the daily per-spender refresh a product commitment or an accident of the
lane's design (cite what consumes `fan_earnings` projections: top spenders board,
insights, agent datasets — and what freshness they need)? (b) what is the minimal safe
reduction you would ship before the browser migration, and what must be measured first?
Give a due/dirty model sketch if you propose one.
