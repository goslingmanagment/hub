# Independent review — completed-run selection

Two independent reviewers, `review_pr162` and `quality_c1`, reviewed source
SHA256 `681aa3c2a22f580aef6ba722268e319cba891fe432f28db83231b29e0105a87d` and the five new completed-run regression cases. They used
local files and retained results; neither queried production or ran another test suite.

Both found no actionable correctness or code-quality issue. The same filters,
finish-time/ID ordering and one SQL snapshot select the same completion. The PK
join loads only that winner's payload. Running-run and physical-attempt CTEs match
base main byte for byte. The change follows existing CTE style, introduces no
abstraction and preserves scope, missing-result behavior and result conversions.

Both independently checked all four paired benchmarks: 102 equal rows per phase,
medians 19.6–23.2% lower, smaller estimated completed WindowAgg row width and
102 single-row PK lookups.
The report explicitly retains increased temp writes (3205→3983), synthetic fixture
limits and unproven production timeout attribution. The earlier physical-history
candidates were rejected on observed failure-heavy regressions; they are absent
from this PR's runtime diff.

The correctness cases cover historical completion, finish/start ordering, ties,
page/stream scope, running or unfinished exclusions, exact payload, all four
completed outcomes and default source/status mapping. Final full-check and serial
Docker-Postgres results are in `VALIDATION.md`.

Final documentation review found a reproduction command missing its test-file
argument. The command now names the single benchmark explicitly. It also asked
that Plan Width be called an estimated row width; Decision 293, this report,
validation and PR description now state that distinction. These are documentation
corrections; benchmark timings and runtime code did not change.

The fixture table now calls the mixed cohort failed attempts on selected run IDs;
its sync-run outcomes remain succeeded. The final reviewer verified this label,
all artifact/source hashes, PK lookup counts, temp writes and test logs.
