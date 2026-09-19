# Read-only release preflight — 11 September 19:00 UTC

No production mutation, protected-health query or privileged SQL was performed.
The three bounded SSH status/loopback-health reads succeeded. The API, worker
and scheduler still run C1 source `d47dc9b09f87` and image `c8a5567e229b…`, all
healthy. Restart counts are 0/1/0; the worker's start is still 03:08:13 UTC.
The ordinary DB probe was 1 ms, the contract remains `af58db69…`, and disk had
23.88 GiB free. This does not close the protected sync-health gate.

## Bounded C1/A0 interval

The existing report helper queried only as `read_only`, inside REPEATABLE READ
READ ONLY with a 20-second statement timeout. Its interval is
17:07:08–19:00:22 UTC, snapshot 19:00:31.405758 UTC. The report hash matches its
manifest; 109 ordered unique timeline records were returned, through run
727342, next cursor null. Pagination exhaustion covers retained rows only.

- Eleven incremental runs have eleven valid decisions: seven no request and
  four count-mismatch requests (two each on Lilly-1 and Lilly-2), all from clean
  queues. The other two OR branches remain unobserved in this interval.
- Four terminal runs certify exact generation membership. Lora-1 revision
  1250/generation 1206 completed at 17:15:16.394 UTC, 9472/9472, with one
  pre-update deactivation candidate. Two later incremental decisions have
  matching 9473/9473 counts and do not request reconciliation.
- Lilly-1 generations 679 and 680 completed with 3360/3360 and respectively
  zero and two pre-update candidates. Lilly-2 generation 783 completed with
  18323/18323 and zero candidates. Actual retired row identities are not
  exported; candidate counts are not proof of a specific row's retirement.
  Lilly-2 revision 2534 is still running in the snapshot. The four requests
  and four terminal runs are different cohorts, not a one-to-one completion claim.
- Retained follower attempts are 22 scheduled incremental and 454 anomaly
  reconcile, with zero recorded retries, terminal failures or HTTP429. No
  new worker-log/run-ID reconciliation was done, and full revisions can start
  before this interval. These are neither a complete cost census nor savings.
- A0 has 22 sweeps started in this interval: 19 incomplete, three running,
  zero complete; 45200 repeated material checks are unknown. Two sweep rows
  updated after the requested cutoff. These counts are not distinct missing
  messages and do not pass shadow acceptance.

This delta is not added to the earlier cumulative snapshot. The raw report,
manifest and summary remain together here. No follower suppression is justified
and no HTTP savings or event-latency distribution is established. A0 retains
its original seven-day clock and separate A1 gate.

## Prepared release

PR172 is merged as `c0cd21c3`. The independently reviewed combined C1 candidate
is `66d6ac1a8979cfb1be6e9c365bbe9dc1981f29f3`, with 3251 passing unit tests,
81 real Postgres tests and a passing production build. All 179 deployed
migration files remain unchanged. Its incoming main includes PR171's Overview
and API/contract changes, which require the normal production-pinned CLI refresh.
The combined Node22 CI is pending; PR166 remains a draft. Deployment of this
exact candidate still needs a new explicit owner approval. The earlier one-use
17:35 EXPLAIN approval is consumed.
