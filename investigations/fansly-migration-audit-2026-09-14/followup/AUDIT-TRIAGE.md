# Follow-up to the owner's 14 September audit

Source: the owner's local `fansly-migration-audit-2026-09-14/REPORT.html` and
six A–F lane reports, checked against main `0a08365f`, production `38032636`
and retained stage receipts. Finding numbers below match the HTML report.
This is the initial work queue, retained with its original dispositions;
it is not the final merge-state ledger. See [RESULT.md](RESULT.md) and
[STATUS.md](STATUS.md) for all 12 merged PRs, the reproduced completion/settlement
fix, final verification and the evidence gates that remain open.

| Finding | Disposition and next bounded action |
| --- | --- |
| 1. Production/main divergence | Confirmed. This PR restores performance fixes and exact applied SQL; C1 and dashboard remain separate prerequisites. |
| 2. Very long provider cooldown | The missing first-failure visibility is real. Preserve the provider deadline required by decision 275; add explicit incident visibility rather than retry before it expires. |
| 3. Cooldown erased by new work | Confirmed in both `requestPageSync` and the newer-request branch of `retryPageSync`. Separate fix must preserve queued revisions and the future provider deadline in both races. |
| 4. Cost comparison | Two-window totals are descriptive, not a causal fleet trend. Remeasure per page and stream with physical attempts, coverage and retries; observations alone cannot count retries. |
| 5. A0 calendar | 17 September is the earliest first seven-day report, not acceptance. On 11 September 234/275 were incomplete: 225 uncertified and nine overlapping. Evidence does not establish a new automatic 19 September acceptance date. |
| 6. A0 material-query cost | The query is awaited on the write path and has a five-second statement timeout. Actual per-page latency is unmeasured; measure before restructuring the observation boundary. |
| 7. A0 hot-head counter | Hot-store-only coverage is confirmed and already documented. It cannot alone prove reader material or zero unexplained omissions. Archive membership or a capture timestamp is not an equivalent pre-apply proof. |
| 8. Earnings rotation | Delayed scheduled work can finish in the next UTC day; the retained activity supports uneven daily work. Reproduce slot/generation semantics before suppressing walks using a rolling cadence. |
| 9. Exhausted head debt | Separate actionable from exhausted debt in history admission while retaining the exhausted discrepancy. The catch-up allowlist remains off. |
| 10. Metadata full-row update | Replace snapshot write-back with a narrow, fenced metadata update; preserve the existing head writer. |
| 11. Capture/replay overlap | Covered by the imported `96a86c1f` fix and regression suites in this PR. |
| 12. Expired earnings claim | Fetch can outlive the claim and settlement can return false. Test expired/stolen claims; preserve revision binding. Moving the claim after fetch can bind a response to a newer revision. |
| 13. Earnings constructors | Use named money constructors while preserving current safe-integer and whole-observation refusal checks. No wrong amount is established by the audit. |
| 14. W0 transport ratchet | Add focused socket-egress enforcement and bypass regressions before merging W0. A regex for bare `connect` alone is insufficient. |
| 15. W0 approval/temporary artifacts | Missing branch evidence is not proof of absent chat authorization. Do not invent a receipt. Temporary secret files were removed; bounded socket/binding/continuity evidence and any remaining remote cleanup are separate work. |
| 16. C1 generation 776 evidence | PR166 follow-up now packages the original full raw receipt, exact subset and provenance. Diagnostic completion does not close the policy or presence gate. |
| 17. Transcript source/window order | Existing code comments and the moved-out regression explicitly require preferred-source selection before the time window. Do not reverse that contract based on this finding; the proposed pre-2024 cohort remains unverified. |

The full audit contains seventeen numbered findings. Its summary groups several
of them together; it does not imply nine additional undisclosed code defects.
This reconciliation does not enable savings modes, shorten the shadow gate or
prove the ≥50% objective. New measurements must retain their actual denominator
and observation coverage.
