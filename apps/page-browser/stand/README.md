# Project Browser — the stand

Checks against the **production** page image and operator of this tree
(`apps/page-browser`, built by its own `Dockerfile`, run by the production
`docker-compose.page-browser.yml`), each run by hand: `image-check.sh` /
`image-check.mjs` (PR 2's image check), `resource-timing-check.sh` and
`part-upload-check.sh` (below), and on the server the publish capture
(`publish-capture/`) over `stand.sh`'s images, under the stand's guard.

## The resource-timing check (variant Б)

```sh
apps/page-browser/stand/resource-timing-check.sh --image hub-page-browser:<tag> [--apparmor unconfined]
```

Hub's API request is an XMLHttpRequest from the isolated world `pb-hub` of
the site's tab, started from `<host>.pb-hold.invalid…#hub-N`. Chrome 155
keeps such a request out of the main world's resource timeline and away
from the site's service worker; CDP does not promise it. The check runs the
operator's own `ISSUE` (`src/hub-requests/page.ts`) and Fetch patterns
against a local site with a service worker, a PerformanceObserver and
main-world hooks — in a container of the image with no network, headed on
its Xkasmvnc, the managed policies masked — and prints one line per
assertion. The main world's own XMLHttpRequest, Image and `<video>` must
show, so a pass is never a timeline or worker that sees nothing. Hub's
Image and `<video>` are reported as `info`: on 155.0.8059.39 the video is in
the timeline under its placeholder name (no media go through the browser
today; how they would is the owner's decision). It runs on every Chrome
update (`chrome-update.sh`, step 7), and `tests/page-browser-image.test.ts`
fails while `PASSED_ON` in `resource-timing-check.ts` is not the
Dockerfile's Chrome. Without `--image` it runs this machine's Chrome,
headless.

## The part-upload check

```sh
apps/page-browser/stand/part-upload-check.sh --image hub-page-browser:<tag> [--apparmor unconfined] [--bytes N]
```

An upload's part is a PUT from the isolated world with no body in the page;
at its release the operator hands Chrome the part's bytes (Fetch's
`postData`). Chrome echoes them in the pause of the part's response, as
text and as base64: 45 MiB for Fansly's 20 MiB part, 145 MiB for 64 MiB.
Kept whole, they filled the holder's 128 MB and killed Chrome on ari-1
(2026-10-27); the holder now keeps such a body as its length
(`trimPausedPostData`). The check runs `ISSUE` and the release against a
local storage that answers like S3 and asserts the part arrived exact
(length, MD5, Content-Length), its request carried no body, and nothing the
holder keeps was over 1 MiB. Without `--image` it runs this machine's
Chrome, headless.

## What is here

| Path | What |
|---|---|
| `stand.sh`, `guard.sh`, `push.sh` | Build the tools image and the page image of this tree; the server's guard; the upload to the server |
| `Dockerfile.tools` | The image of everything that is not the page: Node 22 (as the page image), openssl and NSS tools, tcpdump, busybox |
| `publish-capture/` | The publish capture on the test account (wall posts plan, PR 0.1; runbook `docs/plans/2026-10-23-wall-posts/stand-session-0.2.md`) — this tree's page image with the capture's rules (`Dockerfile`), the stand's engine that starts the page and sends nothing of Hub's (`engine.ts`), `capture.sh` (build, up, collect, down), the journal's reader (`read.ts`). Under the guard |

## The owner's conditions (№14)

| Condition | How |
|---|---|
| CPU and memory limits on every container, no swap, no restart by itself | Every service has `cpus`, `mem_limit` = `memswap_limit`, `pids_limit`, `restart: "no"`; the page containers keep the production file's limits (2 GiB, 1 CPU, `/dev/shm` 1 GiB) |
| Stop at once if prod Hub slows or memory runs out | `guard.sh` (systemd unit `pb-suite-guard`): Hub's `/api/v1/health` every 5 s — one answer over 500 ms, 30 s average over 50 ms, MemAvailable under 4 GiB or load over 6 stops every container labelled `agency.stand=pb-suite` and the builds' BuildKit container; `TRIPPED` holds until `stand.sh clear-trip`; `stand.sh` refuses to build and `capture.sh` to build or start while the guard is not measuring |
| Nothing of the stand runs unwatched | The builds' BuildKit container (`buildx_buildkit_pb-suite-builder0`; buildx gives it no label, so it goes by name) is stopped on any exit of a build — done, failed, interrupted —, by `guard-stop` before the guard goes (which refuses to go while anything of the stand runs), and by the guard's trip |
| Never touch other containers | Everything of the stand carries `agency.stand=pb-suite`; `stand.sh` and the guard filter by it |

## On the server

On the workstation, from a commit:

```sh
PB_SSH_BIND=<en0 address> apps/page-browser/stand/push.sh --remote root@<server> [--rev <commit>]
```

On the server (`R=/opt/pb-suite/src/<rev>/apps/page-browser/stand`):

```sh
$R/stand.sh apparmor-load          # the page image's AppArmor profile, until reboot (not in /etc/apparmor.d)
$R/stand.sh guard-start            # nothing starts without it
$R/stand.sh build                  # pb-suite/tools:<rev>, pb-suite/page-browser:<rev>; BuildKit container with 2 CPU / 3 GB, stopped after
$R/publish-capture/capture.sh …    # the publish capture over those images (its header; the runbook above)
$R/stand.sh guard-stop             # stops what is left of the stand and the builder first; refuses to go while any of it runs
$R/stand.sh builder-remove         # the BuildKit builder itself, when no more builds are needed
```

`<rev>` is the tree's commit (`-dirty` with uncommitted changes under
`apps/page-browser`). On the workstation's Docker Desktop `stand.sh build`
builds the same two images (vendor cache: `~/code/.cache/page-browser`)
without a guard.
