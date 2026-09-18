# Root Node22 follow-up

Same agent03 probe, with two source reads redirected to SHA-matched snapshots because the isolated Node image has no git. Both snapshots independently compared against main and production74aac before copy. All benchmark/parity logic unchanged. Local Docker, network disabled, 1CPU/512MiB bound. Not production host timing.

Source SHA256: 22b33b42ab7ac2628d37c54052e3a36c060f2bd20fba8c43567f11c02d92f75c

## Result

Node v22.23.2 Linux arm64: 86807 byte cases and 11 invalid cases matched.

- dm25: median 2.008 -> 0.357 ms (5.63x); CPU total 50.109 -> 14.461 ms.
- catalog500: median 6.376 -> 1.579 ms (4.04x); CPU total 156.830 -> 39.629 ms.
- longText1MiB: median 77.296 -> 2.705 ms (28.57x); CPU total 1180.958 -> 48.488 ms.

Timing is illustrative: Docker CPU quota and shared Mac load can distort wall time/p95; only 3 warmups/15 samples. No production speedup claim. Node22 image resolved/pulled by Docker at execution (digest sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5); the test process had network disabled. Container exited0 and was removed. No product dependencies or lockfiles changed.
