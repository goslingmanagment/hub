# A0: all twelve retained runtime discrepancies

The expanded comparison finds two flags transitions on the same Lilly-1
conversation below every planned stop candidate. Seven other runtime cases
have no corresponding raw metadata change below the stop; three lack a
comparable complete reconstruction. Those ten cases remain unresolved by this
comparison. The existing full sweeps continued: this is negative early-stop
evidence, not proof that production lost a message.

## Evidence scope

The unchanged runtime baseline contains 425 sweeps through 12 September
11:21:02.842101 UTC. Its twelve state-change observations include eight complete
and four incomplete runtime sweeps. The observations are not unique conversations.
The baseline and its hash remain in `../baseline.json`.

The expanded export selects retained metadata dated 11 September 00:00 through
12 September 11:21:02.842101 UTC within raw IDs `(2794341, 2841584]`.
It scans 47,243 rows and returns 20,208 records. The 48 batch reads and one
upper-bound read ran from 15:27:16 to 15:32:59 UTC on 12 September as
`read_only`, each in REPEATABLE READ READ ONLY with a 20-second statement limit.
This is a selected ID cohort, not a global census or one atomic historical
snapshot of mutable run receipts. No provider requests were added.

Corpus SHA-256:
`89882a3ab5462a53089a46c01cb18b4bf63a0408e591be6e06e790209ed80f1d`.
The original, narrower packet is preserved separately and is not additive.

## Case comparison

Each runtime case binds to exactly one first response in the five-minute
interval after its start, bounded by the next runtime sweep on that page.
This time correlation is not a direct raw-to-generation foreign key.
Incomplete reconstructions clear the local predecessor. Raw page counts must
match the certified sequence. `cases.json` retains these checks and limits.

| Page / generation | Runtime status | Raw comparison below runtime stop |
|---|---|---|
| Lilly-2 / 6753 | Incomplete | Unavailable: interrupted reconstruction, no predecessor. |
| Lilly-2 / 6759 | Incomplete | Unavailable: interrupted reconstruction, no predecessor. |
| Lora-1 / 4770 | Incomplete | Zero changes; runtime discrepancy remains unexplained. |
| Lilly-2 / 6771 | Incomplete | Unavailable: current reconstruction interrupted. |
| Lilly-1 / 7356 | Complete | Zero changes; runtime discrepancy remains unexplained. |
| Lora-1 / 4789 | Complete | Zero changes; runtime discrepancy remains unexplained. |
| Lora-1 / 4790 | Complete | Zero changes; runtime discrepancy remains unexplained. |
| Lilly-2 / 6781 | Complete | Zero changes; runtime discrepancy remains unexplained. |
| Lora-2 / 5443 | Complete | Zero changes; runtime discrepancy remains unexplained. |
| Lilly-1 / 7363 | Complete | Page 12: flags 10 to 1048586. |
| Lilly-1 / 7379 | Complete | Page 12: flags 1048586 to 8. |
| Lilly-1 / 7382 | Complete | Zero changes; runtime discrepancy remains unexplained. |

The two transitions share one group digest. The other compared fields of that
head are unchanged. Their runtime and offline K=3/overlap=60s stop pages agree:
3 for generation 7363 and 4 for 7379. The meaning of the changed bits is not
inferred. Both changes occur at offset 1100, after every tested stop:

| K | Generation 7363 stop | Generation 7379 stop |
|---|---:|---:|
| 1 | 1 | 2 |
| 3 | 3 | 4 |
| 5 | 5 | 6 |

Each position is identical for overlap 0, 60 and 300 seconds. All nine
policies miss each flags transition. These are virtual list-page positions,
not measured HTTP savings. Other conversations can change above the stop.

Runtime compares against pre-apply database state, including effective repaired
fields and concurrent writers. Raw-to-raw comparison cannot reconstruct it.
The generic counter omitted the exact reason and conversation. Zero raw changes
cannot classify a runtime discrepancy as a false positive or prove safe stop.

## Reconstruction limits and validation

Each policy reconstructs 415 sweeps: 282 comparable complete, 74 priming and
59 incomplete. Incomplete reasons are 35 `invalid_record`, 22 `run_unverified`,
one `offset_or_total_drift` and one `end_of_corpus`. These offline counts use a
different scope and certification from the 425 runtime rows.

Twenty-one exported records from failed runs fail the existing sweep schema:
offset, limit and sort order are null; their exported heads arrays are empty.
This metadata alone does not identify the originating capture path or prove a
malformed provider response. The analyzer clears all active sweeps on such a record; all three
unavailable target cases end with `invalid_record`. Their resets follow invalid
records on Lora-1, Lora-2 and Lora-1 respectively, not demonstrated corruption
of those Lilly-2 pages. This conservative reconstruction limit stays explicit.

Its 1,898 invalid-record count is 21 schema errors plus 1,877 schema-valid
pages without an active reconstruction. Only 40 are initial leading pages:
16 Lilly-2 and 24 Lora-2. Do not equate 1,898 with schema errors or lost
provider responses.

The existing nine-policy analyzer, bounded case comparison and streaming schema
check all exited 0. The analyzer source matches the earlier verified release
64149b95. No application source changed; no new unit or Postgres suite was run
for this local diagnosis. Independent review is recorded in `REVIEW.md`.

Keep the flags transitions as negative A1 evidence and preserve polling
freshness. The remaining cases require evidence of their actual pre-apply
reason; aggregated receipts cannot supply it retrospectively. Seven elapsed
days alone do not pass A0. No deployment, flag, cursor, replay or recovery changed.
Private evidence contains head metadata only, with no message bodies, usernames
or credentials; published case samples use a group digest.
