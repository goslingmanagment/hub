# Decision-number coordination

The published W0 candidate `f208d2fac357457b6bdab37a9d26d81824d31acd`
used Decision 333. Concurrent PR194 had already reserved that number for its
separate follower-outreach topic. The coordinator assigned W0 Decision 334.
Only the W0 decision row/heading and current STATUS/PR references are renumbered.
Earlier review text and validation receipts retain their original historical
fingerprints. No decision policy, executable source or test changed. The runbook and current
reports also clarify the existing traffic scope: there are no additional REST
requests, but live connections send HTTP Upgrade handshakes and WebSocket traffic.
Those are separate from `sync_http_attempts`/T0; zero REST requests does not prove
zero provider traffic or cost.

Previous decisions.md SHA-256: `13b0f3529c73d36de8d6e004c940de6a5abcc06330d23514c88f707f18f2b687`.
Current decisions.md SHA-256: `f80de53b82ceceb41320b31611fac10b5489d990a8519d4614648ff39e03cd08`.
Current continuity runbook SHA-256:
`8c60a48be9eb10ebfeace7860d7d0d7f15077cf63bc9329cf66089bdda8c2180`.
All other 20 source-manifest entries match the reviewed and tested candidate.
No local test rerun is warranted for this documentation-only correction; fresh
GitHub checks will run on the newly published commit.
