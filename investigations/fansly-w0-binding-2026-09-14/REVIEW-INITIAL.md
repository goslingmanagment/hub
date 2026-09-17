# Independent review — W0 REST identity binding

Reviewer: `/root/review_w0_binding`. Scope: complete tracked diff and new files in
`fix/fansly-w0-session-binding`, based on main `ac92197ba9760833ae035c3f5e8a90d084010fe6`.
This review preceded the final refusal-receipt fix. No tests or external actions
were performed by the reviewer.

No P1/P2 findings. One P3 finding accepted for correction:

Known binding refusals were discarded by the generic CLI failure handlers. A
rejected invocation left empty receiver output and exit 1, preventing retained
evidence from distinguishing invalid receipt, snapshot mismatch, changed
generation and unavailable generation or recording zero socket attempts.
Unavailable generation also received the mismatch code. Add a small sanitized
refusal receipt for these known cases; keep unrelated errors generic.

The reviewer confirmed preservation of the fixed bounded GET, existing encrypted
session and page dispatcher, no receiver REST or database writes, optional legacy
short receipt, mandatory continuity receipt, checks before connections, original
generation across gaps, shared admission and owned cleanup. Overall binding
scope, fan-out, presence, recovery and W0/B0 acceptance remain unverified.
File sizes, line lengths and whitespace were assessed as reasonable.

Final correction and re-review are tracked separately. This file is not a clean
review of a later revision and is not live provider evidence.
