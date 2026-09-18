# Four additional A0 runtime discrepancies

All four new runtime cases have comparable complete retained sweeps. The
raw-to-raw comparison finds zero metadata changes below their respective stops.
It does not recover their pre-apply database comparison, so the generic runtime
counters remain unexplained. Zero raw changes does not establish false positives.

| Page / generation | Runtime stop | Raw changes below stop |
|---|---:|---:|
| Lilly-2 / 6811 | 3 | 0 |
| Lilly-2 / 6812 | 3 | 0 |
| Lora-2 / 5472 | 10 | 0 |
| Lora-1 / 4820 | 4 | 0 |

The corrected export selects retained head metadata for 12 September
13:30–15:30 UTC within raw IDs `(2835576, 2846005]`. Eleven bounded batch
reads and one upper-bound read ran at 18:44:55–18:45:52 UTC as read_only in
REPEATABLE READ READ ONLY with a 20-second statement limit. They scanned
10,429 rows and returned 1,301 records. This is a selected ID cohort, not a
global census or an atomic historical snapshot. The corpus SHA-256 is
`cee04b1d8894451e11bd53ef9c117b9ed2d844179a48ae04e16247390616430f`.

The first export mistakenly used the previous collection's global upper ID
as though it were the last selected row before that report's cutoff. Its
32 records only cover 15:27:20–15:29:57 UTC and cannot compare these cases.
That evidence is preserved separately. The corrected lower ID is the previous
corpus's actual last returned record, captured at 11:20:59 UTC. The two exports
are not additive; `boundary-correction.json` records this correction.

Each case has exactly one first response within five minutes after its runtime
start, bounded by the next sweep on that page. This is timestamp correlation,
not a generation foreign key. Both current and predecessor raw page counts
match the certified reconstruction. Runtime and offline stop positions agree.
Lora-1 and Lora-2 have changes above their stops; neither Lilly-2 comparison
has a metadata change. No conversation identity is inferred from a zero result.

All 1,301 records pass the existing schema. Each of the nine policies yields
17 comparable complete, six priming and one incomplete sweep; 23 initial
Lora-2 pages precede the first offset-zero response. Those leading pages are
not schema failures. The incomplete reconstruction remains outside comparison.

The six relevant analyzer/runtime source hashes match deployed `31b73a96`
and the earlier reviewed diagnostic packet. The analyzer, schema check and
case comparison exit zero. Comparison logic is unchanged apart from input
paths and the case description. No application code, provider call, flag,
cursor, recovery or production state changed. These checks do not replace
implementation tests or establish safe stop, savings or event latency.
