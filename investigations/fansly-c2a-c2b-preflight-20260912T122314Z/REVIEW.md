# Independent preflight reviews

Both reviewers inspected local evidence and source only. They ran no production
operation or test suite. No runtime code changed in this preflight.

## C1 correctness and documentation

`quality_c1` checked the report hash, read identity, complete timeline, generation
686/687 comparison and the three C1 documentation edits. No findings remain.
The 36 successful attempts, one actual retirement and absence of an active-after
measurement are supported. Neither suppression nor stage acceptance is claimed.

## C2a/C2b evidence and access

`review_pr162` verified source bindings for 18 files, the parser-family scope,
restricted-reader limitations, final census SQL/output hashes, full partition
inventory and the Lilly-1 baseline. It confirmed all 281,525 measured records
are at v7, with projection correctness still unverified. The selected config
response was reviewed as a labeled transcription; the reviewer did not obtain
or independently verify the original HTTP body.

Three P3 findings were fixed and re-reviewed:

- The first access manifest hashed unretained raw stdout. It now binds the
  exact retained JSON bytes; the old manifest and its limitation are preserved.
- `observations_future` is a range partition from 2031-01-01, not DEFAULT.
- The configuration timestamp is `generatedAt`, not an independently recorded
  HTTP receipt time.

Final verdict: review closed, no open findings. The proposed earnings audit
read still requires its own implementation review and tests before deployment.
