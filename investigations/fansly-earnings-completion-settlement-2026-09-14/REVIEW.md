# Independent completion-settlement review

Reviewed on 2026-09-14 by `/root/review_w0_runner`. No outstanding findings.
This is a source and test-design review; the reviewer ran no tests, provider
requests or production commands and made no runtime/test edits.

The candidate is based on `ce0a44b0d6778f8bd371c105f26d31f9abe8b8bd`.
The retained reproduction separately identifies its original `1fe9dbe7` base.
The runtime change adds one early completion check; the existing fetch,
capture, checkpoint and settlement paths remain intact.

## Correctness and boundaries

- The handler requires a matching page and `fan_earnings` execution context,
  its leased request sequence in `cursor_seq`, an exact zero fan cursor and a
  parseable completion timestamp. It asserts current lease ownership before
  returning. A missing context, newer sequence, partial cursor or removed
  checkpoint follows the existing walk.
- The current production handler is the stream's checkpoint writer. Its owned
  writes stamp the executing sequence; successful full completion writes zero
  plus `completedAt`. Partial progress writes a positive cursor, while a first
  rejected fan preserves the previous checkpoint. These states cannot be
  mistaken for completion of the new generation.
- The executor supplies `leasedSeq`, and `completePageSync` checks the exact
  token, leased sequence, running status and database-clock lease expiry.
  Settlement applies only that sequence and leaves a queued newer sequence
  pending. The handler does not assume that the current requested sequence is
  also its leased sequence.
- The existing reset service clears the checkpoint and requests a new sequence.
  Erasure/removed checkpoint cannot be reused. The early return writes no new
  checkpoint, observation, receipt or read timestamp. Ordinary queue completion
  timestamps still describe settlement; they are not fresh provider reads.
- The generic checkpoint repository's unscoped UPDATE retains an existing
  `cursor_seq`; only its unscoped INSERT sets it to null. Therefore this review
  does not claim repository-wide provenance protection against arbitrary legacy
  writers. No additional production `fan_earnings` checkpoint writer was found,
  and the handler explicitly refuses reuse without its execution context.

## Regression coverage reviewed

The eight focused PostgreSQL cases use real scheduling, lease acquisition,
handler capture/checkpoints and settlement repositories with a recording
provider stub. They cover healthy same-slot completion, a real settlement-write
failure followed by same-generation reuse, newer requested work, partial
continuation carrying an older completion timestamp, first-fan rejection,
missing execution context with an already owned checkpoint, lease loss and
checkpoint removal. The failure case checks the entire unchanged checkpoint,
four total endpoint invocations and unchanged captured observation counts.

The harness deliberately invokes the handler/settlement boundary rather than
booting the complete worker. It does not prove production occurrence, the cause
of historical traffic, production savings or C2c freshness gates. Validation
results belong to the author's retained test receipts. Decision 331 and the
runbook describe these limits accurately and introduce no flag or migration.

## Reviewed SHA-256

| Path | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/sync/fan-earnings.ts` | `0cfa7c51a5934adb1b5ab01a4bb5d78fa425180cc7fc75690495988d6a37fe0d` |
| `tests/fan-earnings-completion-settlement.integration.test.ts` | `27741462f746888b94df2ba28311533b510ffe549a0b0f82fd9baf7e0c13d67f` |
| `docs/decisions.md` | `c144931d339d230537499a194565c92008db12b99961066ed880d7c4d4b428c1` |
| `docs/runbooks/fansly-earnings-shadow.md` | `7e41406d69ffcbd12a62cf898bc1a66ffde807e143d30e58850a7d0061901ceb` |
