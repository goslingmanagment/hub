# Independent C2b observation review

Reviewer: `/root/w0_role_tests`, 2026-09-14T05:21:03.347708+00:00.
Local retained-artifact review only; no production calls, tests, state or code edits.
Packet: `/Users/dmitriy/.codex/worktrees/hub-fansly-c2b-shadow/investigations/fansly-c2b-earnings-shadow-2026-09-10/activation/20260912T233234Z/observation-20260914T051301Z`.

**Passed; no unresolved actionable findings. The current-state alias correction was fixed and independently rechecked; the observation and gate are unchanged.**

Both manifests verify byte-for-byte: all **9 current** and **10 previous** listed
artifacts. The comparison's previous packet is `observation-20260913T231118Z`.
The only raw differences are `identity.asOf` and `shadow.as_of`. No endpoint,
outcome, scope or completed-sweep data changed. The command exited 0, stderr is
empty, and receipt hashes match the raw files.

SQL uses the `read_only` login, REPEATABLE READ READ ONLY, 15-second statement
and 1-second lock limits, then ROLLBACK. The retained identity independently
reports `read_only`, `readOnly=on`, `isolation=repeatable read`. The receipt records
a 25-second remote process limit, 1-second kill grace and 40-second outer bound.
There is no role fallback or provider request in the retained command.

At 05:13:03.019337 UTC, each lifetime/monthly endpoint still has **99 tracked
fans, 99 valid checks, 99 visits, 99 receipts, 99 checked within 24 hours**.
Both have zero pending/retry, active/expired claims, never-checked, missing or
in-flight receipts, changes, changes without a signal and older checks.
Unknown attribution is zero while **tracked_scope_complete=false**. These scoped
baseline facts do not prove quiet correction coverage or full attribution.

The one post-activation completion remains **September 13 10:53:03.993 UTC**, excluded
as transitional because its full start after enablement was not proved.
First tracked endpoint timestamps are not full-sweep start proof. There are
**0 of 2 qualifying subsequent independent daily sweeps**; original observation
start remains **September 12 23:38:22.888 UTC**. Both current stage/activation states
retain the excluded transition, zero qualifying sweeps, undelivered report and
unmeasured physical savings/event latency. C2c remains gated. No observer
completion or deletion is justified by this packet.

The current configuration response reports desired C2b `lilly-1` version 1,
matching running values on all three active roles. Its boolean summary fields
`runningState=unknown`, `desiredEffective=null` do not contradict those strings
(see companion runtime review). Exact per-role applied versions and historical
continuity remain unproved. This is review of the supplied ordinary refresh
receipt, not an independent browser replay. Runtime health/source are current
snapshots, not proof of a protected deployment gate.

## Current-state alias correction — resolved

The initial state aliases still described the prior UI receipt as having no
version, with a September 13 observation timestamp, despite correctly attached
current configuration evidence. Root updated both state files; reviewer rechecked
`currentEffectiveValue=lilly-1`, desired version 1, all three reported role values,
response timestamp 05:09:34.958, null per-role applied version and false historical
continuity. The explicit scope limits effective value to the current reported
values. Original activation fields, observation clock, transition exclusion and
zero qualifying sweeps are unchanged. Prior aliases are preserved in the shared
`c2b-before-current-flag-alias-0/1.json` receipts.
No need to reinterpret string keys' unknown boolean summary as missing values.
The activation's original report is historical; its old W0 Management-only
sentence is superseded by the explicit current state pointer to owner-approved
REST-token W0 and was not rewritten during this review.

## Reviewed hashes

| Artifact in current C2b packet | SHA256 |
|---|---|
| `manifest.json` | `bb245f16fc8e8c51dd38f0676bc9f9e5671f0f4c8483ae4e134a644231685d24` |
| `read.raw.json` | `84b5219e2bac9ba8b1e16e93969bb7fab3433a4fe37994680b182d58a05cb44f` |
| `read.sql` | `675110ba23d471b2737d046d367b837324a7b1c2f341477b234fa8b0f9172e5f` |
| `read.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `execution.json` | `9267ed6e149dcd9826957c1036a0f70a102bccc8df234a64f53f58ada95b0818` |
| `comparison.json` | `dd91a6b5b1252a6b386ff944e82db657b72664e0c39244085e989ff86ab06a46` |
| `REPORT.md` | `1a4ca8eba131803ad91ec81e48e329b35a9025c05ff67a2d8d7e12fc7cfbca04` |

Previous manifest: `9e494cb85c3ca410de91f46a01ce12200c75c7ea1e5090c6e3d6b62dd98418c4`.
Shared configuration receipt: `54fc062dd4347fcfe0f1ddbfd85f2530f0a2ec20fb37433feab72a7b6a523c96`.
No state/hash claims extend to later completion-alias edits.

State snapshots at recheck, before root completion aliases: activation
`70f27711e9b0542b889fb4630826ac5a93ebfe6093788461d8152801e53ba69e`;
stage `f65411cdcd1402c64df34af7e1d9fff5183e1290ade9ec853125a7e4386638e3`.
