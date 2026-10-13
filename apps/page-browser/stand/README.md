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
| `runner/engine.ts` | The engine as the operator meets it, over the real RPC (`src/rpc/protocol.ts`): hello with the page's token and generation, ping/pong, commands, the event stream committed to the stand's Postgres and acknowledged only after the commit, outcomes and `resultAck`, `recover`, and the admissions (`checkResult`, `siteAdmitResult`, `wsAdmitResult`) — each journaled with its absolute deadline |
| `runner/scenarios.ts` | The scenarios (below) |
| `runner/criteria.ts` | The plan's criteria as pure checks over a run's evidence (unit tests: `tests/page-browser-stand.test.ts`) |
| `runner/series.ts` | A series: N valid runs per scenario, the fault at a random moment drawn from a recorded seed, a result file per run |
| `runner/verify.ts` | The verdict of a finished series, from its files alone |
| `runner/load.ts` | The common load test and spec §4's thresholds |
| `runner/isolation.ts` | Before anything runs: no route out, the SOCKS5 connects only the stand's names, the stand's certificate is trusted only with the stand's CA |
| `capture/` | tcpdump in each page container's network namespace: what left it at the OS level |
| `inside/entry.sh` | The stand's entry in front of the image's `/init` (see "Seams") |
| `docker-compose.yml`, `page.stand.yml` | The stand's infrastructure; the stand's override of the production page file |
| `docker-proxy.ts` | The runner's only way to Docker: exec, start/stop/restart, inspect, stats — of the stand's own containers |
| `stand.sh`, `guard.sh`, `push.sh` | Build, up, series, load, verify, down; the server's guard; the upload to the server |
| `Dockerfile.tools` | The image of everything that is not the page: Node 22 (as the page image), openssl and NSS tools, tcpdump, busybox |

## The owner's conditions (№14)

| Condition | How |
|---|---|
| Own Compose project, network and Postgres | Project `pb-suite-<stand>`; two **internal** networks (no route out; `isolation.ts` checks it); the stand's own `postgres:16`, trusting only its network — no password anywhere |
| CPU and memory limits on every container, no swap, no restart by itself | Every service has `cpus`, `mem_limit` = `memswap_limit`, `pids_limit`, `restart: "no"`; the page containers keep the production file's limits (2 GiB, 1 CPU, `/dev/shm` 1 GiB) |
| Disk fill only on a fixed-size separate volume | The `disk` page's buffer volume is a 640 MiB tmpfs; `disk-full` fills only that, from inside the page container |
| DB unavailable only on the stand's DB | `db-unavailable` stops `pb-suite-<stand>-postgres-1`; the Docker proxy passes nothing else |
| Stop at once if prod Hub slows or memory runs out | `guard.sh` (systemd unit `pb-suite-guard`): Hub's `/api/v1/health` every 5 s — one answer over 500 ms, 30 s average over 50 ms, MemAvailable under 4 GiB or load over 6 stops every container labelled `agency.stand=pb-suite`; `TRIPPED` holds until `stand.sh clear-trip`; `stand.sh` refuses to build, start or run while the guard is not measuring |
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
$R/stand.sh guard-stop
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
| C1 | No API request and no socket reached Fansly without an admission in force; one admission is one operation (a request and at most one preflight) | the stand's journal against the engine's grants |
| C2 | No closed write (anything but the login's) | the stand's journal |
| C3 | No forbidden socket message (only the authorization and `p`) | the stand's journal |
| C4 | No traffic past the proxy: only the SOCKS5 and the RPC's answers leave the page container | the OS capture |
| C5 | Nothing reached the stand's direct listener | the stand's journal |
| C6 | Every attempt the engine issued resolved exactly once (one committed outcome or a recover answer); "not sent" never of a request that arrived | the stand's Postgres, the journal |
| C7 | No event deleted before the engine committed it (no hole in a buffer's numbers) | the stand's Postgres |
| C8 | The stand's Fansly had no error | the stand's journal |

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
| `control-duplicate` | — | **control**: an engine that commits without a key and acknowledges late, dropped between — C6 must catch the duplicate |
| `control-hole` | — | **control**: an engine that acknowledges events before it commits them, its database down while the operator's start writes its gap — C7 must catch the hole |
| `site-steady` | PR 7 | the site works (reads, its socket, frames): every request and socket under its own admission, frames committed |
| `site-loss-operator-kill`, `site-loss-cdp-break`, `site-loss-chrome-kill` | PR 7 | the loss scenarios with the site's requests waiting and Hub requests in flight (condition №1; decision №10's residual shows in C1) |
| `site-proxy-down` | PR 7 | what waited when the proxy failed is never sent after it is back (plan §4.5) |
| `site-admission-expiry` | PR 7 | an admission runs out while its connection is set up (the SOCKS5 holds the CONNECT 20 s, the admission is 15 s), then the delay goes: nothing arrives after its deadline (condition №2) |
| `site-engine-restart` | PR 7 | `recover` with Hub requests released: never `not_sent` of one that left |
| `site-closed-writes` | PR 6, PR 7 | the site's closed writes never reach Fansly |
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
`--outage-minutes`, and measures the offload; cgroup counters every 5 s.
`results/load/<name>/report.json` holds spec §4's thresholds — 1 pages at
once, 2 requests per hour, 3 frames, 4 frame → Postgres p95, 5 the browser's
addition, 6 the buffer's age, 7 the outage, 8 resources, 9 Hub and Postgres —
each with its value and whether it held, or why it was not measured: until
PR 7 no request leaves and no socket opens (2–5 wait for it), and 9 is about
Hub's own queries, which are not on the stand.

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
  `pb-chrome`; the disk fill with `fallocate` on the disk page's volume.
