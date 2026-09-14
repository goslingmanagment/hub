# Independent review: W0 and earnings codec on main ce0a44b0

Reviewed 2026-09-14T01:26:15.235763+00:00. No outstanding findings.
This is a local Git/source composition review; no tests, branch edits, push,
production calls or provider requests were performed by this reviewer.

| Topic | Prior published head | Reviewed local merge | Verified tree paths |
| --- | --- | --- | ---: |
| W0 | `9a21d1e1acacb56902ae60a31595109f0cd8cd7f` | `8f907db9624c9a7b652b3969634afcc61dfe910a` | 2,248 |
| Earnings codec | `c1fb7cac4385c66d848400e971f1e085b188c6a7` | `e81384a86269b301848595174a07d2be2c414cd0` | 2,174 |

Both merges have main `ce0a44b0d6778f8bd371c105f26d31f9abe8b8bd` as their second parent and
`a9794e600dfbb10918800ab5b49241e33d7357a3` as the common base with the
prior published topic. Main's tree is the previously reviewed
`7bc44a84fff7c7329e12c229f5b398a8d60fefd7`.

Every tracked path except the intentional decisions merge was checked against
its exact three-way source. Paths changed only on main equal main, paths changed
only on the topic equal the prior topic, and unchanged paths retain their blob
and mode. There are no unexpected shared source edits. All **34 W0 source,
configuration and test paths**, including the socket lint rules and fixtures,
are byte-identical to the prior W0 head. All **three earnings-codec source/test
paths** are byte-identical to the prior money head. Each branch inherits all
**95 incoming main code/test/CI paths** byte-for-byte. The topic runbooks,
review artifacts and other documentation are preserved by the same whole-tree
comparison; only `docs/decisions.md` is composed manually.

## Decisions

The resolver script `/tmp/fansly-merge-decision.py` uses main as the full-document
base, inserts the prior topic's quick-reference row and section by decision
number, and rejects conflict markers. I checked the results independently:
D325 is before D327 and D329 follows D327; the topic rows and body text are
unchanged. Every existing main row and decision body survives. Removing D325
recovers exact main bytes. Removing D329 and its added separating blank line
also recovers exact main bytes. The blank separator is formatting only.

## W0 lint and incoming dashboard interaction

The W0 ESLint file remains identical to `9a21d1e1` (SHA-256
`bdbf7669f551fa84ab1d2fb17d052937db96ee0a1dc7904b335e5396de99d09a`). Its new WebSocket restrictions
apply only to `apps/runtime/src/**/*.ts` and `packages/*/src/**/*.ts`, excluding
services/egress. The incoming dashboard files are outside those new globs.
The globally shared money and HTTP import restrictions retain their prior
selectors; extracting their definitions does not introduce a dashboard-only
restriction. The only incoming main files inside the new server globs are
`executor-handlers.ts` and `packages/db/src/repositories/page-dm.ts`; neither
contains WebSocket/undici imports or constructor references. No source or
configuration conflict was found here. This static inspection is not a fresh
ESLint execution.

Both branches inherit the exact main CI workflow (SHA-256
`3f8b9318fabb991f1ec5c37952c2dd1d24b35b6e1eb92c223c15d3b5b27b905f`), including
`NODE_OPTIONS: --max-old-space-size=4096` on the static-check job. No test or
validation gate is removed; test scripts retain their own explicit limits.

Prior receipts still certify the unchanged topic code. These new merges inherit
reviewed main changes; fresh PR CI must certify the composed heads before merge.
There is no reason to repeat full local suites solely for byte-identical topic
code. No fresh passing-test claim is made in this report.
