# Independent money-codec composition review on main 1a567b1c

Reviewed on 2026-09-14 by `/root/review_w0_runner`: no findings. The candidate
preserves the reviewed codec change and all incoming main changes. No tests,
branch/index mutations, network requests or production actions were performed
by this reviewer. Fresh successful CI remains required before merge.

| Input | Exact identity |
| --- | --- |
| Prior money head | `77cc1b7c1d60a0b0a6252d8b611017789dabe2e9` |
| Incoming main | `1a567b1c75721293fd77acd943fae9d6f1a9c7a3` |
| Common base | `ce0a44b0d6778f8bd371c105f26d31f9abe8b8bd` |
| Reviewed merge | `e70c417f446e735f9e0840a4540d379040c0af78` |
| Reviewed tree | `f4175be18dfd9109e706640f951bda8ba567b7cf` |

Compared all 2,245 paths and file modes across the common base, both parents
and merge. Every non-decision path matches its supplying parent exactly. All
three money source/test files are byte-identical to the prior head; all 11
incoming runtime/database/test paths are byte-identical to main, including
C2b receipt renewal and the history/voice fixes. Existing evidence and reviews
are retained by the same whole-tree check.

The exact D329 body and reference row are inserted between D328 and D330.
Removing these insertions recovers the entire main decisions file byte-for-byte,
including D326, D327, D328 and D330. No source conflict required adaptation.

## Earnings interaction and readability

The receipt builder already calls `parseFanslyEarningsObservation`; that shared
dependency predates this merge. The codec change preserves accepted integer
amounts, existing rejection rules, event fields and content fingerprints while
using the repository's named bigint summation and number-boundary helpers.
C2b renewal only extends the same token/revision under the owned transaction;
it neither changes the parsed payload nor uses a new monetary representation.
The receipt builder itself is unchanged. There is no new parser/claim cycle,
HTTP request, state transition or money-to-receipt contract introduced by the
composition.

The implementation remains two direct helper substitutions and focused numeric
boundary cases. It adds no adapter, generic policy layer, flag or larger module.
The previous readability and correctness review still describes the exact
source present here.

## Retained validation

The original `pnpm check` log reports 3,423 passing unit tests and nine skips;
the four serial PostgreSQL suites report 26 passes and no skips. Both receipts
and compressed logs exactly match the prior head. Decompressed SHA-256 values
match the receipts:

- Check: `594343d8c7d3830047b2178164e9499e5697dca6146fac9c44504d8082559a74`
- PostgreSQL: `cb6b24ed0a8dea36100ea307195837b80357b169c64f663964ae4e656ae0c02a`

All three topic files and all four PostgreSQL suite files also match the
retained validation source manifest. These remain valid historical evidence
for the unchanged codec change; they are not a newly executed validation of
this merge head or a substitute for its fresh CI.

| Topic file | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/canonicalize/fansly-earnings.ts` | `8dbe8d7acd333bc6c8b959b77bfed222e3634bfcfe43f1bd7e8a9aa08d3d978c` |
| `apps/runtime/src/services/projections/fan-earnings.ts` | `86ca301979f09a55b48f20f2645d0f2bbcfa7ddebfe76634d46f4c052bdf11ce` |
| `tests/canonicalize-fansly-earnings.test.ts` | `efefdb28ff1b56801250ed9fd1f5ecf72678596b5b0a3e3d07d4cdc3717d8adf` |

## Later documentation composition

Temporary three-way text merges with the reviewed W0/C2b tree
`d59ed3121969cdfa48d7bd4690819691148581be` and completion head
`b6349638d2f5b289d9b342be7a2403ea123a06d2` also succeed. D325 inserts before
D326 and D331 after D330, separately from D329. The combined decision order is
D325 → D326 → D327 → D328 → D329 → D330 → D331. The synthetic decisions text
hash is `bfbd541ab6638923ec1d9f59ea42a03a00c23603a0d400ab400c923260323e02`;
this is not a committed multi-topic tree or a claim that those CI gates passed.
