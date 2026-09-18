# Independent evidence packet review — PR197

Reviewed from local receipts and Git objects on **2026-09-14, 19:48:04 UTC**.
No remaining actionable P1, P2 or P3 evidence findings were identified in the
reviewed packet. The report supports a merged operator-tool prerequisite; it
does not establish live W0 acceptance or migration completion.

The reviewer independently recomputed SHA-256 for the contents of all 30 files
in `validation/agent-source-sha256.json` using both Git revisions. The manifest
covers exactly the changed paths from base
`ac92197ba9760833ae035c3f5e8a90d084010fe6` to tested/reviewed HEAD
`9f727fe17464158c6c7136b78bb414b27f841d47`; every hash matches. HEAD and merge
commit `1d0ed3cf8232c24f659d37db9ceda21d65d09dd3` both resolve locally to tree
`51ad62cb352a709a1615a162626fe999be6ff9b4`. This independently confirms the tree
and source claims in [COMMIT-VERIFICATION.json](COMMIT-VERIFICATION.json) and
[MERGE-VERIFIED.json](MERGE-VERIFIED.json). The earlier source review accurately
describes an uncommitted tree at its own review time; the subsequent manifest
comparison connects that reviewed source to the committed result.

The three retained bundles independently match the recorded SHA-256, byte size
and mode 0600 in `validation/bundle-sha256.json`. Build and invalid-argument
receipts show successful bundle construction followed by the expected safe exit
before runtime configuration/provider work. No bundle was rebuilt or executed
by this reviewer.

Reported verification results agree with the saved evidence:

- `pnpm-check.json` records exit 0. Its log records 333 passing files, 3821
  passing tests and nine skips, followed by successful dashboard construction.
  The typecheck ratchet explicitly retains 1897 known errors within its budget;
  the report does not misstate this as zero TypeScript errors.
- The final isolated PostgreSQL log records 16 passing tests. The source and
  previous review delimit the checked snapshot and no-write invariants. These
  fixtures are not a production database observation.
- The first serial run contains the binding transport suite among its eight
  passing files; the only reported failures are the two named PostgreSQL fixture
  failures. The transport source defines 15 cases. The final unit command also
  includes that suite. Its transport evidence uses loopback fixtures, not Fansly.
- The Python log records 4, 10 and 8 passing tests, all with mocked Docker and
  local private fixtures. The report states that limitation.
- Initial fixture SQL, dispatcher interception and CLI warning failures remain
  retained and distinguished from their successful reruns and the final check.
- [CI-PASSED.json](CI-PASSED.json) records five successful checks for the stated
  HEAD in run 34887226869; the separate watch receipt records exit 0. The local
  workflow requires successful static/integration dependencies for Quality Gate
  and permits image publication only on a main push, consistent with the saved
  PR publication job being skipped. The saved merge receipt records MERGED at
  19:43:34 UTC with the stated merge commit. GitHub was not queried again during
  this review.

The stage table is consistent with [REMAINING-GATES.md](REMAINING-GATES.md) and
the dated progress packet it cites. The older audit's pending CI/merge wording
is explicitly historical and is superseded only by the final CI/merge receipts.
The A0 calendar point is not represented as seven valid measured days; the C1
Lora-2 follow-up is not added again to its cumulative cohort; C2b still has one
qualifying completion of two. The cited SQL timings remain separate unmatched
samples, and neither realized HTTP savings nor event-to-reader p95/p99 is
claimed. Targeted C1 and C2b local source packets corroborate those qualifications.

W0 still needs live generation-bound identity evidence, paired delivery,
independent presence observation, six-hour continuity and recovery evidence.
B0/B1 remain behind their own prerequisites, and B2 remains parked. The owner's
new selection of Ari as presence observer is operational steering being recorded
by the root agent; the transient older pending-input field is not a code or
acceptance defect. Selecting an observer alone supplies no live gate evidence.

The report and state record no production deployment, flag change or new
provider measurement for PR197. This review confirms the packet's scope and
absence of any claimed live acceptance; it does not independently certify the
current production or browser state. No remote, production, provider, UI,
test, build or source-mutation action was performed by this reviewer. The only
write in this evidence-review pass is this file.

Reviewed report SHA-256:
`d70e3b5995dd921a7fee9f7090d89f60166b99b7279b77a4c5d5030551418351`.
Reviewed remaining-gates audit SHA-256:
`ff2ab7b31930200e81adfa0671ba7ee6da25a7f22f6b2c76d077e036e32399d3`.
Later observer-context updates to mutable state are outside this timestamped
review and do not change the verified source/tree identity.
