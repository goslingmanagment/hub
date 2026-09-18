# Independent review of the W0 live preflight

Reviewed on 14 September 2026. Scope: local source, the retained preflight
receipts and the final `REPORT.md`. No production calls, test runs, browser
actions, launches or source changes were performed by this reviewer.

**Verdict: no actionable factual findings in the report; keep the six-hour
Lilly-1 run pending.** The missing prerequisites are evidence, not a missing
repeat of the owner's existing authorization. This review does not request a
new approval for an already authorized action.

## Launch decision

The current protocol runbook, lines 168–171, requires page/account binding
through the authorized REST path for the same credential generation before a
new probe. Lines 200–201 retain evidence gates for wider or sustained use.
D334, lines 13619–13626 of `docs/decisions.md`, separates successful collection
from reviewed binding, browser delivery, presence and REST recovery. It does
not waive the preceding requirements or establish those proofs.

The accepted plan's glossary equates “socket on a working page” with B0, so
the fan-out/presence table row alone would not establish a blanket prohibition
on every limited diagnostic probe. The current runbook and the unwaived
sequence in the cross-check `DECISION.md`, line 162, are the relevant additional
constraints. Independent collection does not require simultaneous experiment
starts; that fact is not permission to skip prerequisites for sustained use.

The saved browser attempt leaves the selected session, route and binding
unverified. The next action is to unlock the Mac and inspect the selected
Lilly-1 browser context, then establish same-generation REST binding and the
required bounded paired observations. Lilly-1 is the creator-side page; a
separate viewing account serves independent fan-visible presence observation.

No implementation defect blocking preparation was identified in the launcher
or helpers. Before an eventual run, retain the concrete invocation, private
inputs, generation and correlation-key provenance, stop control and object
boundaries. The launcher checks socket failures and sampled configuration
generation, but does not detect browser delivery loss or REST restrictions.
Those require independent observations and operator stop handling. A confirmed
boundary before each planned gap and ordinary REST/reader receipts remain
necessary to assess recovery.

## Evidence checked

- The continuity bundle and all five Python launcher/module hashes match
  `source-pins.json` and the reviewed `ac92197ba976` source checkout.
- `host.stdout` records Python 3.12.3, the existing Docker network, three healthy
  roles with zero restarts and the same immutable runtime image, no W0 container
  at that observation, private runtime-environment mode and 17,301,684 KiB free.
  This is a point-in-time metadata read, not continuous admission or availability
  proof and not proof of page proxy or credential binding.
- `browser-access.json` records the locked-Mac result and its public-contract
  provenance. It explicitly leaves browser session and page proxy unverified.
  This review checked the retained receipt, not a new browser attempt.
- The final report accurately retains no new socket, continuity, recovery,
  savings, latency or W0/B0 acceptance claim. It records withdrawal of the
  earlier broad launch recommendation before any provider action.

## Exact reviewed hashes

| File | SHA-256 |
| --- | --- |
| `REPORT.md` | `85dd332e1bc5f8edbde57da8486c3709b5c15ff094aac84d314918251bbd1b69` |
| `source-pins.json` | `5d6cadeed78b68ed8c02bbc27b60634bd9d3a6b9045532201295398363639050` |
| `browser-access.json` | `f25a82e8f4186201e96a5420d062389383a2e6876c2cad1342899f0ce91673d6` |
| `host.stdout` | `c40613bd7bbd67340d33eace082d839078e62f671fe3726b667f00ab2a9f1c8d` |
| `host-execution.json` | `d8962c58392df43a2e798a7c9ecbe2651c7c1f88df3a58bbb6bb7f3258c9347e` |
| Prepared continuity bundle | `e8a7845f341a0c19d23608284ddc087b046d63973d2ec1a23ff6b4cb1e983d1e` |
