# Independent quality review — 15 September 2026

Reviewer: `/root/w0_next_scope`. Reviewed the author's frozen 15-path change
against `b5900cfcf41a5a29d45a7c8c7c8ee0b2a76dce3e`, including new files omitted
from an ordinary tracked diff. No tests, source edits, provider/production/browser
actions or edits outside this review file were performed. The root owns execution
validation; the separate transport reviewer owns its detailed API/redaction audit.

**No actionable quality, readability or scope findings.**

The 70-line collector has a bounded purpose: retain an allowed transport code and
outer response status for one attempt. Its `errorSeen` and `finished` states have
distinct roles: preserving the first error even when unclassified, and preventing
cleanup from changing the terminal snapshot. Explicit callback forwarding makes
the interception boundary readable. The helper does not introduce a shared event
bus, global subscription, dispatcher ownership scheme or persistent diagnostic
state.

Observed connection phase remains in the existing shared observer. Short and
continuity callers each allocate one collector and pass that same instance to
the socket and observer. The short wrapper exposes the previously discarded
`openedAt`; it does not duplicate authentication or transport control logic.
Capture limits, timers, credential/generation checks, connection count, cleanup,
REST behavior and business writers retain their existing paths. The small shared
network-fixture extension supplies the new rejection case without a second test
transport implementation.

## Receipt and documentation consistency

The fields are additive within existing receipt envelopes. The current short
comparator selects its existing fields and tolerates these additions; the Python
continuity receipt reader likewise preserves the observation without rejecting
additional diagnostic keys. Older receipts remain valid with their original
unknowns, and no code invents missing historical open/status/error values.

D338, the focused runbook section and STATUS.md accurately separate open, type-1,
an exposed outer HTTP status, an internal CONNECT response and the stored account
generation. `pre_open` describes an observed boundary, and `UND_ERR_ABORTED`
does not identify an actor or a proxy cause. Other stop reasons keep null phase.
The failed live attempt remains unresolved; these changes do not claim recovery,
compatibility or W0 acceptance. STATUS correctly leaves the root's pending test
lane separate from the author's completed standalone synthetic check.

## Test design review

The additions cover distinct failure modes: pre/post-open and type-1 independence,
construction/auth-send/ping exceptions, first-error retention, freeze before
cleanup, unknown/cyclic/deep/throwing causes, and a changing getter read exactly
once. HTTP status cases distinguish interim/invalid status, 101 and rejection.
Original objects and handler receiver/control results are checked, and synthetic
secrets must not appear in reports.

The existing real local CONNECT and SOCKS suites now exercise the collector on
success, rejection and untrusted TLS while retaining their no-global-fallback,
no-REST-pacing and exact destination assertions. Continuity tests check the same
terminal boundary and timer cleanup. These are meaningful behavioral tests rather
than an additional suite merely restating constant values. They were inspected,
not executed by this reviewer.

## Reviewed source identity

The SHA-256 of sorted `sha256  relative-path\n` entries for the frozen 15 intended
paths, including STATUS.md and excluding this review/validation output, is
`b496ed3daeafb4f32dc8b83392f38fd884946ec104dabfc8e04f4203d4709416`.

- Collector: `601f600ea5c41c0d6fc7ecaff63f407ae9f0844fdb42e4b1a7aadd3773d4cce6`
- Shared observer: `959795973372cb89cdb2eb91d32a338920a12636e3ac98ba14d39d39ec4ca683`
- New diagnostics tests: `e17caddcd9b325f7b7aa8e6bf6d2523f3b090db089629e74509c39fa63ae28b4`
- D338 decisions file: `7966132dfa5a6340d48e5ffd9883ed5c2366b283761bc302a4cd408499010ada`
- Protocol runbook: `f2d8229aaea77e2deb22585792e210e2525d669034af2e3898de8b7eb3962a03`

This verdict covers that source snapshot. Completed root validation and the
separate transport review remain the release evidence; this quality review alone
does not authorize or establish another live experiment.
