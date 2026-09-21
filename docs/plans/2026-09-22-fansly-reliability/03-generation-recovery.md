# 03 — Make generation rotation a checked recovery operation

## Root cause

Generation hashes the stored session and egress. Decision 366 intentionally stops B1 after either changes. The missing operational mechanism is a checked policy transition plus visible mismatch. Blindly replacing the digest on every connection would weaken the account/scope fence.

## Proposed change

Add a small service and CLI preview/apply operation for one existing enabled permanent policy. Preview returns only page/native-account identity, configured/current generation, current B0 connection identity/guard status and an independent account-me binding result, policy version/fingerprint, and explicit blocking reasons. No token, proxy URL or message body is printed.

Apply requires the exact reviewed preview/version and uses the existing generation lock plus audited config writer/CAS to replace only that page's generation. Use the existing inspectFanslyBinding with the exact readProbeSnapshot dispatcher, without retry/redirect, before preview and apply. An object-shaped B0 session frame does not prove account identity. Under the lock recheck the inspected generation, native identity, policy CAS and non-auth-refused state. Report connection guard/verification as diagnostics, not as identity proof. Preserve activationAt, baseline/reference, attempt cap, enabled types, flags and all other page policies. Refuse malformed, absent, disabled or expired/canary policy and any concurrent config/identity/generation change. All generations still count toward the same 24h cap. Repeated apply should be safely recognizable as already-applied, not duplicate an audit transition.

Expose mismatch/unverified B0 as a bounded technical health/status reason in detailed status and the preview output. It must not degrade /health/sync, which is also the deploy gate. Avoid a new notification subsystem or a high-cardinality metric. Do not claim historical alert delivery was absent; document how to verify it.

Document that old disabled receipts remain retained and are not silently re-routed. The preview/apply command restores future routing; explicit historical reconciliation uses the normal recovery paths, without resetting watermarks or budgets.

## Acceptance

Integration: matching verified rotation previews/applies exactly once and audits; stale token/config version, unknown/wrong account, failed account binding, generation rotated during apply, expired policy and disabled flag refuse with no writes. Other page policies and all budget rows remain unchanged. Detailed diagnostics show mismatch even with recent ordinary REST success; intentional off remains off. Rollback returns to refusal without deleting data.
