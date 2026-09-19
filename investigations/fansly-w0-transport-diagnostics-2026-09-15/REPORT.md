# PR199 transport diagnostics — merged release evidence

[PR #199](https://github.com/goslingmanagment/core/pull/199) merged at
2026-09-14 21:28:07 UTC (15 September Europe/Moscow): reviewed head
`bb4c6f917286224a2a6f6a3c9ffaabbbf6536fbe` → merge
`069cfe9b0978365f889733c9cc7b0d141ac6f3ba`.
[MERGE-VERIFIED.json](MERGE-VERIFIED.json), recorded at 21:28:25 UTC, retains
the GitHub state and exact head/merge identifiers. This independent packaging
review checked the saved receipt without a network refresh; the merge object
was not available in the local object database at packaging time.

The change preserves the observed open timestamp, fixed failure phase,
allowlisted transport error code and exposed outer HTTP status in the short
and continuity receipts. It freezes those observations before cleanup. Unknown
causes remain unknown; HTTP 101 alone does not prove open or authentication,
and an internal CONNECT status is not reconstructed.

The retained checks consistently identify that reviewed head:

- [CI-PASSED.json](CI-PASSED.json) and the merge receipt show five successful
  checks in run `34897461459`: Static checks, Integration 1/3, Integration 2/3,
  Integration 3/3 and Quality Gate. **Publish checked production image was
  SKIPPED**, not successful publication.
- [pnpm check receipt](validation/pnpm-check.json) and its original log show
  exit 0 at 21:07:22–21:08:41 UTC: **3,835 tests passed, 9 skipped, 334 files
  passed**; lint and dashboard build passed. The ratchet retained 1,897 existing
  errors within its prior budget across 120 files; it reported no new debt.
- [Postgres receipt](validation/postgres.json) and its original log show exit 0
  at 21:08:41–21:08:49 UTC: **16 tests passed** in the Docker-Postgres probe
  context suite.
- [Operator build receipt](validation/operator-builds.json) records three
  successful bundles: short, continuity and binding preflight. All three retained
  bundle hashes match the receipt.
- All 12 source/test hashes in both before/after validation snapshots match
  each other, the working files and the committed PR head. The independent
  [transport](REVIEW-TRANSPORT.md) and [quality](REVIEW-QUALITY.md) reviews have
  no unresolved findings. The changing-getter defect was corrected before the
  recorded test runs.

This is an operator diagnostic change. No API, worker or scheduler deployment
is required; no runtime deployment or new live Hub attempt was performed as
part of this release. The motivating 158 ms attempt remains a failed attempt
with an unknown transport cause and no paired server corpus. This release does
not establish W0 acceptance, stability/recovery success, savings or latency gains.

Separate native preparation was interrupted. Its retained
[browser-interruption receipt](../fansly-w0-continuity-2026-09-15/diagnostic-followup-preparation/browser-interruption.json)
records an earlier WetLillys/Lily-1 identity and HTTP 101 observation, but no
retained Received-frame corpus. At the later window check only a blank Firefox
window was exposed; the intended reference was inaccessible. The cause and
closure of the owned Ari/Lilly tabs remain unverified. The receipt records no
new Hub receiver, Hub REST request, remote staging or correlation key. A future
attempt still requires actual observer readiness and the reviewed admission
checks; **W0 remains unverified**.

All 17 original files were copied byte-for-byte from the matching worktree
investigation directory, including original logs, bundles and historical
receipts. [STATUS.md](STATUS.md) is preserved as its pre-PR/CI readiness snapshot;
this report supplies the subsequent release outcome. The reviews likewise keep
their original source snapshots, including the earlier STATUS hash; STATUS's
later validation update and both reviews match their committed PR-head files.
This packager ran no tests and performed no production, provider, browser,
proxy, staging or source changes. No credential or raw correspondence artifact
was added. Files are private (0600), directories 0700.

`SHA256SUMS` seals the 17 unchanged originals plus this report, excluding the
manifest itself. The separate browser-interruption receipt is a linked source,
not an entry in this release manifest.
