# Lora-3 generation 775/776: retained production evidence

This packages the already completed, independently reviewed 13 September
observation into PR166. It performs no new production read and changes no
runtime policy. The [original report](REPORT.md) and [independent review](REVIEW.md)
retain the main checkout's operational evidence. The review is byte-exact; the
report only has its extra trailing blank line removed. Provenance retains both
source and packaged hashes.

Generation 775 retained one relation under generation grace and recorded zero
deactivations. The next requested revision completed generation 776 with one
candidate and one actual deactivation. Five later incremental comparisons matched
provider/active counts and requested nothing. This closes that natural follow-up;
it does not establish same-relation identity, atomic active-after state, redundant
work, equivalent presence coverage or savings.

The nine exact source records used by the report are in
[timeline-subset.json](timeline-subset.json). Their run IDs are
`734952, 735021, 735379, 735448, 736007, 736470, 736918, 737405, 737798`.
The subset is not an exhausted timeline. Full source-window metadata and the
selection rule are retained separately from its records.

The complete original 334-row receipt is retained as `read.raw.json.gz`.
Decompression reproduces the original bytes and SHA-256
`a612e75f8b4242abe0d1427258f8254a0808ab11b1f82cc8374029441ca6c57a`.
This permits checking the original 39 Lora-3 rows, both generation checkpoint
chains, the five later comparisons and source pagination without another
production query. Compression only reduces repository size.

[PROVENANCE.json](PROVENANCE.json) records source paths, original reviewed hashes,
copied-file hashes, subset IDs and exact object parity. `read.sql` and
`execution.json` retain the actual bounded read-only command and its successful
outcome. The raw identity is `read_only`, READ ONLY, repeatable read, asOf
`2026-09-13T00:02:38.837060Z`; the window ends at `00:02:35.324525Z`.

`REPORT.md` and `REVIEW.md` describe the original dated observation. Their
references to original summaries/raw JSON mean the source artifacts pinned by
PROVENANCE; the full raw receipt is compressed here. `runtime.json` is historical
metadata from that observation, not a current runtime or deployment check.
