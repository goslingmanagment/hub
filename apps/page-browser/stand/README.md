# Project Browser — the stand suites (plan §5, stage 2; stage 3, PR 19)

Failure series and the common load test against the **production** page
image and operator of this tree (`apps/page-browser`, built by its own
`Dockerfile`, run by the production `docker-compose.page-browser.yml`). The
prototype's stand (`proto/project-browser`, `stand/`) proved the mandatory
conditions on the prototype's operator; this one runs before every operator
PR (plan §5, row 19).

`image-check.sh` / `image-check.mjs` in this directory are PR 2's image check
and are not part of the suites.

## What is here

| Path | What |
|---|---|
| `fansly/` | The stand's Fansly: the page's SOCKS5 (its only exit), and behind it one TLS front for Fansly's **own names** — `fansly.com`, `apiv3.fansly.com`, `wsv3.fansly.com`, `cdn*.fansly.com` — and `api.ipify.org`, with a certificate of a stand-only CA. Its journal of everything that physically arrived is the truth the criteria judge by. Faults on command: the SOCKS5 down, logins refused, a slow CONNECT, another exit IP |
| `runner/engine.ts` | The engine as the operator meets it, over the real RPC (`src/rpc/protocol.ts`): hello with the page's token and generation, ping/pong, commands, the event stream committed to the stand's Postgres and acknowledged only after the commit, outcomes and `resultAck`, `recover`, and the admissions (`checkResult`, `siteAdmitResult`, `wsAdmitResult`) — each journaled with its absolute deadline. It is the stand's own, not main's engine (`apps/runtime/src/sync/`), and admits by that engine's rules (`runner/admissions.ts`): one admitted operation of the page in flight, a Hub request or a site request alike — the operator's send gate is built on it (`src/egress/gate.ts`) —, Hub and site taking turns, the pace counted from a request that may have left (one that never left, refused or "not used", sets none), nothing before the operator's `quiesced`; the site's requests oldest first, an id admitted once, what a connection that went asked and was not answered dropped (the operator asks it again). Between the runs of a series it admits nothing: every attempt is issued and settled inside the run that judges it. The bursts of Hub requests some main scenarios send at once go past the turns on purpose (outcomes on their way at a fault; no session of the site there, so none of them leaves) |
| `runner/scenarios.ts` | The scenarios (below) |
| `runner/criteria.ts` | The plan's criteria as pure checks over a run's evidence (unit tests: `tests/page-browser-stand.test.ts`) |
| `runner/series.ts` | A series: N valid runs per scenario, the fault at a random moment drawn from a recorded seed, a result file per run |
| `runner/verdict.ts`, `runner/verify.ts` | A run's verdict from its checks; the verdict of a finished series, worked out again from each run's own file |
| `runner/load.ts` | The common load test and spec §4's thresholds |
| `runner/isolation.ts` | Before anything runs: no route out, no way to the host through the stand's bridges, the SOCKS5 connects only the stand's names, the stand's certificate is trusted only with the stand's CA |
| `capture/` | tcpdump in each page container's network namespace: what left it at the OS level |
| `inside/` | What the stand runs inside a page container: `entry.sh` in front of the image's `/init` (see "Seams"), `lever.ts` for the controls that send from the page's own address, `journal.ts` to read the operator's own journal |
| `docker-compose.yml`, `page.stand.yml` | The stand's infrastructure; the stand's override of the production page file |
| `docker-proxy.ts` | The runner's only way to Docker: exec, start/stop/restart, inspect, stats — of the stand's own containers |
| `stand.sh`, `guard.sh`, `push.sh` | Build, up, series, load, verify, down; the server's guard; the upload to the server |
| `Dockerfile.tools` | The image of everything that is not the page: Node 22 (as the page image), openssl and NSS tools, tcpdump, busybox |

## The owner's conditions (№14)

| Condition | How |
|---|---|
| Own Compose project, network and Postgres | Project `pb-suite-<stand>`; two networks, **internal and isolated** (Docker's gateway mode `isolated`: the bridges have no address on the host, so neither the internet nor the host's own listeners — sshd, Hub's Caddy — are reachable; `stand.sh up` checks the options as created, and `isolation.ts` checks from inside that `.1` of each subnet does not even refuse on 22, 80, 443); the stand's own `postgres:16`, trusting only its network — no password anywhere |
| CPU and memory limits on every container, no swap, no restart by itself | Every service has `cpus`, `mem_limit` = `memswap_limit`, `pids_limit`, `restart: "no"`; the page containers keep the production file's limits (2 GiB, 1 CPU, `/dev/shm` 1 GiB) |
| Disk fill only on a fixed-size separate volume | The `disk` page's buffer volume is a 640 MiB tmpfs; `disk-full` fills only that, from inside the page container |
| DB unavailable only on the stand's DB | `db-unavailable` stops `pb-suite-<stand>-postgres-1`; the Docker proxy passes nothing else |
| Stop at once if prod Hub slows or memory runs out | `guard.sh` (systemd unit `pb-suite-guard`): Hub's `/api/v1/health` every 5 s — one answer over 500 ms, 30 s average over 50 ms, MemAvailable under 4 GiB or load over 6 stops every container labelled `agency.stand=pb-suite` and the builds' BuildKit container; `TRIPPED` holds until `stand.sh clear-trip`; `stand.sh` refuses to build, start or run while the guard is not measuring |
| Nothing of the stand runs unwatched | The builds' BuildKit container (`buildx_buildkit_pb-suite-builder0`; buildx gives it no label, so it goes by name) is stopped on any exit of a build — done, failed, interrupted —, by `guard-stop` before the guard goes (which refuses to go while anything of the stand runs), and by the guard's trip (`tests/page-browser-stand-scripts.test.ts`) |
| Never touch other containers | Everything of a stand carries `agency.stand=pb-suite` and `agency.stand.name=pb-suite-<stand>`; `stand.sh` filters by them; the runner sees no Docker socket |

## Run it on the workstation (Docker Desktop)

```sh
apps/page-browser/stand/stand.sh build             # pb-suite/tools:<rev>, pb-suite/page-browser:<rev> (vendor cache: ~/code/.cache/page-browser)
apps/page-browser/stand/stand.sh up t1             # one page (p1) and the disk page; --profiles N for the load test
apps/page-browser/stand/stand.sh series t1 s1 --wait -- --runs 3
apps/page-browser/stand/stand.sh verify t1 s1
apps/page-browser/stand/stand.sh load t1 l1 --wait -- --minutes 2 --outage-minutes 1
apps/page-browser/stand/stand.sh down t1           # results stay in ~/code/.cache/pb-suite/stands/t1/results
```

`<rev>` is the tree's commit (`-dirty` with uncommitted changes under
`apps/page-browser`). `PB_SUITE_PAGE_IMAGE=<tag> stand.sh up …` runs this
tree's suites against another page image — an operator PR's, built from its
own tree (PR 6's `069a3873` passed every scenario once that way: its
self-test, with the rules extension, passes under the stand's names and CA). Series options: `--runs N` (default 20), `--seed N`
(recorded; the same seed draws the same moments), `--only a,b`,
`--except a,b`. A run that could not be set up before its fault is not
counted and is replaced (at most N + 2 more).

`verify` does not take the summary's word: it works each run's verdict out
again from the checks in the run's own file (every common check must be
there), and the file's `ok`, the record's `ok` and counts must say the same;
a run number counted twice, a run file the record does not name, a failed
run marked "not set up" are problems. A control passes only when each check
it exists for shows each of its violations and no other check fails.

## Run a series on the server

On the workstation, from a commit:

```sh
PB_SSH_BIND=<en0 address> apps/page-browser/stand/push.sh --remote root@<server> [--rev <commit>]
```

On the server (`R=/opt/pb-suite/src/<rev>/apps/page-browser/stand`):

```sh
$R/stand.sh apparmor-load          # the page image's AppArmor profile, until reboot (not in /etc/apparmor.d)
$R/stand.sh guard-start            # nothing starts without it
$R/stand.sh build                  # BuildKit container with 2 CPU / 3 GB, stopped after
$R/stand.sh up s1 --net 10.233     # --net: the stand's two /24s (10.233.0/24, 10.233.1/24); pick free ones
$R/stand.sh series s1 de-<rev> -- --runs 20      # in the background; log in /opt/pb-suite/stands/s1/results/series.ts-de-<rev>.log
$R/stand.sh status s1
$R/stand.sh verify s1 de-<rev>     # PASSED / NOT PASSED with every problem; skipped scenarios listed with their reason
$R/stand.sh down s1
$R/stand.sh guard-stop             # stops what is left of the stand and the builder first; refuses to go while any of it runs
$R/stand.sh builder-remove         # the BuildKit builder itself, when no more builds are needed
```

Results: `/opt/pb-suite/stands/<stand>/results/series/<name>/` — `series.json`
(seed, revision, image, scenarios), `<scenario>.json` (runs and verdict),
`<scenario>/run-<n>.json` (seed, moment, each check's violations, notes);
the capture files in `results/capture/<page>/`.

The load test needs room: each page is up to 2 GiB and 1 CPU. Seven profiles
(`up --profiles 7`) do not fit the guard's thresholds with Hub on the same
server without the owner's approval (stage 2 report §5).

## The criteria of every run (plan §5, stage 2)

| | Check | Over |
|---|---|---|
| C1 | No API request and no socket reached Fansly without an admission in force — the page's own (by the address it comes from at the SOCKS5), for that URL (a socket: for its host — the address `wsAdmit` names is a label, the host alone while CDP has said nothing of the socket yet, and the operator binds the socket at its handshake), inside its window; one admission is one operation (a request and at most one preflight) or one socket: a second arrival under it is a repeat | the stand's journal against the engine's grants |
| C2 | No closed write (anything but the login's) | the stand's journal |
| C3 | No forbidden socket message (only the authorization and `p`) | the stand's journal |
| C4 | No traffic past the proxy: only the SOCKS5 and the RPC's answers leave the page container — and the capture is evidence at all: the runner sends the page a sentinel datagram when the run begins and when it ends, and both must be in the capture (a stopped tcpdump, or one in a namespace the page has left, shows nothing and proves nothing). A run begins only once the capture is seen live: before its start sentinel the runner sends probes, one a second, until one is in the capture — a capture just (re)started needs a moment before it listens — and with none in 10 s the run is not set up, and is run again | the OS capture, the run's interval exactly |
| C5 | Nothing reached the stand's direct listener | the stand's journal |
| C6 | Every attempt the engine issued resolved exactly once (one committed outcome or a recover answer); "not sent" never of a request that arrived | the stand's Postgres, the journal |
| C7 | No event deleted before the engine committed it, by two records kept apart from the store. **The operator's numbers:** every number between the run's bounds is stored — from the engine's position when the run began (the highest number any engine of the page had committed or acknowledged; 1 for a buffer new to it) to the highest number the operator sent on the wire, the tail included. A number an earlier engine acknowledged and never committed (`control-hole`) was lost in that run, and that run's C7 showed it. **What Fansly made:** every frame the stand's Fansly sent into a page's socket is stored as its `ws.in` event (by the frame's own number), every API request it answered has its stored outcome, and one the site's admission let go has besides its outcome its `site.response` event (by its request id; complete, or marked incomplete) — the two travel apart — except what a committed gap mark covers by time, which is counted (`notes.fanslyMade.coveredByGap`), never silently absent | the stand's Postgres against the wire's bounds and against the stand's journal |
| C8 | The stand's Fansly had no error | the stand's journal |

The first half of C7 is the operator's own word: its end bound is what came
on the wire (the operator's buffer file is its own while it runs —
`locking_mode=EXCLUSIVE` — and the stand does not open it), so an event the
operator lost before ever sending it leaves no number to miss. The second
half does not ask the operator. The stand's Fansly numbers every frame it
sends (`standFrame` in the payload; numbers never repeat across restarts of
the stand) and journals it with its socket, its connection and the time
(`ws.out`), and journals every answer it wrote (`res`); the run compares
that with the stand's Postgres. A gap mark excuses only what lies between
the last event saved before the break (`fromWall`; unknown: everything
before the mark) and the mark itself (`atWall`), within 250 ms — the gap's
clock is the operator's, the frame's is the stand's. A frame or an answer
at the very end of a run is waited for up to 5 s before it is called lost.
A site answer (admitted by `siteAdmitResult`) needs both its outcome
(`siteDone`) and its `site.response` event; Hub's own request needs its
outcome only.

Each scenario adds its own: the exit seen closed within a bound, the stop
reason (a failure with a retry, or a halt), back up by itself or only on
`restartBrowser`, the gap mark written, and so on.

## The scenarios

Main runs them against the operator as it is; "PR 7" ones are skipped (with
the reason in the series) until the operator loads the site and admits its
requests — they light up by themselves then: the series looks for the
operator's `site_loaded` step or a request for `https://fansly.com/`, and the
stand's `fansly.com` page then plays the site (reads with the session's
headers and `fansly-client-check`, its socket, pings, a closed write or a
forbidden message when asked). "PR 6" waits for the rules extension in the
image (the self-test no longer reports `dnr_*` as not installed).

A setting of the stand's site changes only what the next load gets, so every
run of a site scenario loads the page anew (`restartBrowser`) after
configuring it and waits for the page's own word on which variant it is
(`/stand/hello?variant=…`); a run on another variant is not counted. And each
site scenario asks its run for evidence of what it is about (requests the
site did send, a write it did try, a request whose admission ran out while
it waited for its connection, a request in flight at the restart): without
it the run fails — it would prove nothing.

The expiry keeps two things apart (`criteria.ts`). **Safety** is C1's, in
every run of every scenario: nothing arrives after its admission's
deadline, by the stand's own record, one admission one use. **Whether a run
of `site-admission-expiry` proves anything** comes from two sources that do
not lean on each other: the operator's own `requests` journal
(`/data/buffer/logs`, read in the page by `inside/journal.ts`) must end one
specific site request — by its site request id and attempt, at or after its
deadline — with

    {"decision":"ended","admission":"site request <id> (attempt <n>)","result":"not sent: the admission's deadline passed before the send", …}

(PR 7, `src/intercept/site.ts`: the send gate expired the request's window
with nothing of it sent, then the request ended unsent — a page's cancel or
a failed tunnel ends with another result), and the stand's SOCKS5 must show
a CONNECT of that page's API host held across that deadline. Both, or the
run proves nothing and fails. That request must then never arrive. The
SOCKS5's word alone is no evidence: a tunnel cut early does not cancel the
operator's pending CONNECT (`src/egress/proxy.ts`), so a hold across the
deadline does not say that the request still waited. Hub's own path
journals no end of its request (its deadline refusal is the outcome
`aborted_before_send`, `send_deadline_passed`), so only site requests count
here. The control (`control-site-late-send`, and `control-held-late` in
main) must show a request arriving after its journaled deadline over the
very CONNECT held across it — the arrival's SOCKS connection, which the
front journals with every request, is that held one — and C1 calling it
late. A late arrival over another connection does not make the control
pass; it is a C1 violation in its own right.

| Scenario | Needs | A pass proves |
|---|---|---|
| `loss-operator-kill` | — | the operator killed (SIGKILL): the exit dies with it, s6 brings a new one that stands until `restartBrowser`, an `operator_start` gap is written, every attempt resolved once |
| `loss-operator-hang` | — | the operator hung (SIGSTOP): the watchdog kills it within its 5 s, then as above |
| `loss-holder-kill` | — | the CDP holder killed: the exit closes at once, `cdp_lost` alarm, Chrome goes, the page starts again by itself |
| `loss-chrome-kill` | — | Chrome killed: `chrome_crashed`, the exit closes, the page starts again by itself |
| `loss-cdp-break` | — | the DevTools connection broken with every process alive (a TCP reset on port 9222): `cdp_lost`, the exit closes, the page starts again by itself |
| `loss-planned-stop` | — | `stopPage`: the exit closes, the page holds (`owner_stop`) until `restartBrowser` |
| `proxy-down` | — | the SOCKS5 gone: `proxy_unavailable`, the exit closes, the page stands while it is gone and resumes by itself when it is back with the same IP |
| `proxy-auth` | — | the SOCKS5 refuses the login: `proxy_auth`, then as above |
| `exit-ip-change` | — | the exit IP changed: `exit_ip_changed`, a halt that holds even when the IP comes back, until `restartBrowser` |
| `engine-link-loss` | — | the engine silent mid-request: the operator counts the link lost after its 5 s and closes it, the page stays up, outcomes come again on the next connection, each committed once |
| `engine-restart` | — | the engine restarts mid-request (a new generation): `quiesced`, `recover` answered, the page stays up |
| `db-unavailable` | — | the stand's Postgres down: nothing acknowledged, the page stays up, everything committed once after |
| `disk-full` | — | the buffer's disk full (the tmpfs volume): `disk_full`, the exit closes, an alarm; room back — a `disk_full` gap first, then the page starts by itself |
| `container-restart` | — | the page's container restarts with its volumes: the same profile and buffer, the owner generation remembered (an older hello is refused), the page stands until `restartBrowser` |
| `control-leak` | — | **control**: an unadmitted read, a closed write and a socket with a forbidden message reach the stand — C1, C2 and C3 must catch them, in every run |
| `control-bypass` | — | **control**: a hole in the page's rules and a connection past the proxy — C4 and C5 must catch it |
| `control-no-capture` | — | **control**: the capture stops during the run — C4 must say there is no evidence, not pass on silence |
| `control-double-open` | — | **control**: one socket admitted, two opened under it from the page's own address (through its SOCKS5, with a one-time login) — C1 must catch the repeat |
| `control-duplicate` | — | **control**: an engine that commits without a key and acknowledges late, dropped between — C6 must catch the duplicate |
| `control-hole` | — | **control**: an engine that acknowledges events before it commits them, its database down while the operator's start writes its gap — the lost event is the tail, and C7 must catch it (the operator's numbers) |
| `control-lost-frames` | — | **control**: events made and lost before the engine ever received them — the stand's Fansly sends three frames into a socket opened from the page's own address (one, under an admission), which the operator never saw; and it answers a request sent under a site admission of a real attempt, whose outcome the stand commits as the engine does on `siteDone` while no `site.response` event of it ever comes (main's operator sends neither: PR 7 — this half stands in for the engine's side). No number is missing, nothing came on the wire, no gap mark — C7 must catch both against the stand's own record of what it made |
| `control-held-late` | — | **control**: the expiry's control side, live in main — a request admitted for 6 s is sent from the page's own address through a CONNECT the SOCKS5 holds 10 s: the run must show it arriving after its deadline over the very CONNECT held across it (the check `control-site-late-send` runs on the real operator); C1 must call it late, and C7 must miss the outcome of a request Fansly answered |
| `site-steady` | PR 7 | the site works (reads, its socket, frames): every request and socket under its own admission, frames committed |
| `site-loss-operator-kill`, `site-loss-cdp-break`, `site-loss-chrome-kill` | PR 7 | the loss scenarios with the site's requests waiting and an admitted request — the site's or Hub's — in flight at the fault (condition №1; decision №10's residual shows in C1). The state is made and proven, not hoped for: the API's connections are dropped and their CONNECTs held, an admission without its end, its deadline ahead, waits on a held CONNECT — the moment is drawn inside that state and proven again right before the fault (`notes.inFlightAtFault`); not proven, the run is not counted |
| `site-proxy-down` | PR 7 | the site's requests that waited when the proxy failed — asked an admission and not given one, or admitted and not ended; recorded right before the failure, and there must be some — never go after it is back, whatever admission they get then (plan §4.5) |
| `site-admission-expiry` | PR 7 | an admission of 6 s runs out while the site request waits for its connection — the SOCKS5 holds the API host's CONNECT 10 s, inside the 15 s after which the operator's own SOCKS5 client would give up, so it is the deadline that must stop the request — then the hold goes: that request never arrives, and nothing arrives after its deadline (condition №2); the run must show the operator's deadline refusal of one site request with a CONNECT held across its deadline |
| `control-site-late-send` | PR 7 | **control**: the same hold, the operator told 14 s while the engine journals 6 s — the send after the journaled deadline is what an unchecked deadline looks like: a request must be seen arriving after its journaled deadline over the very CONNECT held across it, and C1 must catch it |
| `site-engine-restart` | PR 7 | the engine restarts while a Hub request that reached Fansly waits for its answer (the stand holds the answer 8 s): made and proven before the fault — the site's session live, the request sent in its turn and arrived, unanswered; not proven, the run is not counted — and shown again unanswered at the restart: `recover` never says `not_sent` of it |
| `site-closed-writes` | PR 6, PR 7 | the site tries its closed writes — its own reports say a write was cancelled, and there must be one — and none reaches Fansly |
| `site-forbidden-ws` | PR 7 | a forbidden socket message never leaves; the page stops with `unknown_ws_message` |

What main's operator does in these runs, so a pass is read right: until
PR 7 the work tab stays `about:blank`, every request of the page is failed
in the interception, and each Hub `send` is answered "not sent" (the site is
not loaded) — through the buffer, durably, replayed and recovered like any
outcome. So C1–C3 can only show that nothing leaves (which the controls show
they would catch), the event stream carries the gap marks, and the scenarios'
own checks — the page's reaction to each fault — carry most of the weight.

## The load test

`load.ts` starts the stand's pages at once, keeps each page's engine at the
ceiling (one request in flight, the next after S × (1 + u)), pushes socket
frames at 246 a minute per page with bursts at 492, takes the engine away for
`--outage-minutes`, and measures the offload; cgroup counters every 5 s, a
capture sentinel to every page every 30 s. `results/load/<name>/report.json`
holds spec §4's thresholds, each `held` true, false, or null — not measured,
with the reason:

| | Threshold | Held only if |
|---|---|---|
| 1 | pages at once | the run had 7 profiles |
| 2 | requests per hour per page | every page's own requests in the stand's journal reach 1240 an hour |
| 3 | socket frames | every page got at least 95 % of the asked rate in the background and in each burst (what the stand pushed to that page, phase by phase) |
| 4 | frame → Postgres p95 | measured on frames committed before the outage |
| 5 | the browser's addition | (needs requests that leave: PR 7) |
| 6 | the buffer's age p95 | under 2 s over the states received |
| 7 | the outage | a backlog did pile up during it on every page, every event of it is stored afterwards, once, within 10 min |
| 8 | resources | peak memory ≤ 90 % of the limit, no OOM, at least half of the 5 s samples taken |
| 9 | Hub and Postgres | not on the stand (Hub's own queries are not here): reported, never part of the verdict |

The verdict is `PASSED` only if every threshold of the stand held and no
criterion (C1–C5, C7, per page) was violated; `FAILED` if one did not;
`INCOMPLETE` if nothing failed but something was not measured — never a
pass (exit 0, 1, 3). Until PR 7 no request leaves and no socket opens, so a
run against main is `INCOMPLETE` by construction: 2–5 and 7 wait for it.

## Seams (the stand changes nothing of the image)

- **Names.** The page reaches the stand's Fansly under Fansly's real names:
  the operator and the rules extension (PR 6) name them, and the stand must
  not change either. The page's exit is the stand's SOCKS5, which resolves
  those names to its own front and refuses every other destination; the
  stand's networks have no route out.
- **TLS.** A CA made for the stand (`fansly/certs.ts`), trusted only inside
  the stand: Chrome takes it from `~pb-chrome/.pki/nssdb` (made by the
  stand's Fansly, copied by `inside/entry.sh` — the image has no certutil and
  gets none); the operator's Node — for its exit-IP check through the SOCKS5
  — through `NODE_EXTRA_CA_CERTS`, which `inside/entry.sh` adds to the
  operator's run script in the container (the script starts it with
  `env -i`). A seam in the image would be cleaner: an optional extra-CA file
  the run script passes on when it exists.
- **Route.** The internal networks give no default route; `inside/entry.sh`
  adds an on-link one over the egress network so that `net-selftest` sees the
  page's own rules refuse (stage 2 finding 2).
- **Faults from inside.** Signals and `s6-svc` for the processes; for the CDP
  break, two `nft` rules in the page's own table that reset port 9222 (the
  resets themselves let through); for `control-bypass`, a hole for
  `pb-chrome`; the disk fill with `fallocate` on the disk page's volume; for
  `control-double-open`, `control-lost-frames` and `control-held-late`,
  `inside/lever.ts` as the operator's user, with a login the stand's SOCKS5
  takes only while that control runs (the page's own never leaves the runner
  and the operator).
