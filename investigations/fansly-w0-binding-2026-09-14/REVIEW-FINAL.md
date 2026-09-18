# Independent final source review — W0 REST identity binding

Reviewed on 2026-09-14 in
`/Users/dmitriy/.codex/worktrees/hub-fansly-w0-binding`, branch
`fix/fansly-w0-session-binding`, against base
`ac92197ba9760833ae035c3f5e8a90d084010fe6`. HEAD still equals that base: the
reviewed implementation is an uncommitted working-tree change, including its
new source and test files. This review is not a committed-revision or built-bundle
attestation.

No remaining actionable P1, P2 or P3 findings were found in the reviewed scope.
The initial review's one P3 finding, loss of the known binding-refusal outcome at
the CLI boundary, is closed by the current source.

The recheck traced `BindingRefusal` from private receipt validation and snapshot
comparison through the immediate generation reread to both receiver CLIs.
Invalid receipt, snapshot mismatch, changed generation and unavailable generation
now have distinct, allowlisted reasons. The CLIs write a bounded
`w0_binding_refusal` record with `connectionAttempts: 0` and `restRequests: 0`
and exit unsuccessfully. All production construction sites for this typed error
precede the socket observer. The optional receipt hash is emitted only as a
validated lowercase SHA-256 string; provider bodies, input fields, arbitrary
exception messages and stacks are not copied into the refusal record. Unknown
exceptions retain the generic failure path. The continuity host stops on the
nonzero container result before treating a refusal as a completed observation
stream or starting another phase.

The full implementation review and this correction preserve the required gates:

- The separate preflight uses the existing decrypted session, stored account ID
  and page dispatcher from one verified READ ONLY / REPEATABLE READ snapshot.
  Its fixed account/me GET has bounded time and body consumption, without
  redirect following, application retries, direct fallback, pacing or business
  writes. The ordinary REST adapter is unchanged.
- The short receiver keeps its previous invocation when no receipt is supplied.
  The continuity receiver requires the receipt. Both validate the supplied
  evidence and current page/account/generation before attempting a socket, then
  recheck generation without another credential decrypt. Continuity retains the
  original receipt and expected generation across the three phases.
- Preflight, short and continuity launchers share host/page admission, Docker
  naming and bounded cleanup of only the owned container. Private receipt copies
  are mounted read-only and removed by the existing context-manager cleanup.
- D325, D334, D336 and the two runbooks preserve separate live approvals and
  distinguish REST identity evidence from socket actor scope, continuous
  configuration history, fan-out, presence, recovery, completeness and W0/B0
  acceptance. Receiver REST counters do not hide the preflight GET.

The new modules have focused responsibilities and reasonable file sizes and line
lengths. The refusal correction remains a small explicit boundary; it does not
introduce a general exception-export mechanism. `git diff --check` against the
stated base passed during the recheck.

Test execution was explicitly outside this reviewer's scope. The reviewer read
the new CLI subprocess assertions and updated receipt/runtime tests, but did not
run Vitest, Python suites, builds, production commands, a browser, a proxy or any
provider request. Test and build results must be taken from the separate
execution evidence. The only file written by this reviewer is this review
artifact; implementation files were not edited.
