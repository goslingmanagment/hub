# 02 — Keep additive hint failures from poisoning ordinary DM polling

## Root cause

fanslyDmMessagesChunk awaits runFanslyWsHintStep before its ordinary candidate loop. Raw transport errors escape the hint handler, so the executor marks the shared stream failed/backing off. The audit matched 34 Lilly-1 and 21 Lilly-2 failures to the exact failed B1 run IDs. Some runs are hint-only; do not infer all 55 skipped an ordinary loop.

## Proposed change

Keep the existing scheduler, physical-attempt ledger, shared page rate limit and lease. Isolate only failures positively attributed to the B1 HTTP attempt, recording a subject outcome and bounded retry time before returning control. Track the admitted request id and its terminal transport/timeout failure in the existing observer, only after telemetry succeeds; do not swallow arbitrary TypeError/Error from normalization, DB, capture, writer fences or telemetry.

Known transport failures and addressed 404/5xx without account-wide Retry-After become B1 subject retry/debt, using the existing consecutive_failures counter for exponential backoff from 60 seconds to one hour, recorded durably on that subject. Admission refusals get their actual bounded reason (budget, expiry, policy, generation), not one opaque admission_deferred bucket. On a scheduled run the ordinary loop proceeds if its remaining wall/request budget permits. On hint-only dispatch use the existing quality hold so neither successful nor deferred hint work certifies ordinary freshness, clears ordinary failure state, or resolves its incidents.

401/403 account-auth errors, 429 or explicit shared Retry-After, ownership/generation changes during persistence, capture failures and local invariants retain executor policy. Do not mask a genuine shared provider outage; record enough bounded outcome evidence to distinguish additive deferral from shared blocking. Do not make a fake successful B1 receipt or refund an admitted request.

## Acceptance

Use a transport-shaped failure emitted by the adapter/observer: hint subject gets retry evidence and an ordinary scheduled read still runs. A hint-only failure does not advance success/freshness or clear incidents. Tests prove auth, 429/Retry-After, capture/DB exceptions and lost leases still propagate; transient state survives restart, backoff is bounded and a new signal does not erase an in-flight walk. Existing physical request budget tests stay green.
