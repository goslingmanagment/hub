# Desktop reads during a kernel outage (break-glass) + Stage 24 rollout plan

Kernel Stage 24 removed the desktop's Direct-OFAPI read mode (DP 8): every
OFAPI read now routes through the kernel's read gateway with a hub
credential, and the team-wide `ofapiKey` was deleted from every machine's
keychain on first run of the Stage 24 build (unrecoverable by version
rollback — by design).

## Accepted trade (DP 8)

Kernel down ⇒ desktop reads come from the **local SQLite cache only**. Chat
history, fan profiles, and spender boards remain browsable; nothing
refreshes until the kernel returns. Sends were already hub-only (command
outbox) and queue locally.

## Break-glass procedure (owner-run, kernel-side)

Break-glass is an ops action, never a client feature:

1. **Prefer restoring the kernel** — `scripts/deploy-production.sh` rollback
   or a container restart is almost always faster than any workaround.
2. If the kernel is down hard and an urgent read is needed, the owner issues
   a **temporary OFAPI key** from the OnlyFansAPI dashboard and uses it
   directly (curl / OFAPI console) — the key never goes onto chatter
   machines.
3. Rotate that temporary key immediately after the incident.
4. **Team-key rotation after fleet confirmation**: once every machine runs
   the Stage 24 build (x-client-version telemetry), rotate the old team
   OFAPI key kernel-side — it may have been present on N machines.

## Stage 24 rollout plan

1. **One machine first**: install the Stage 24 build on a single Windows
   machine; verify sign-in (Settings → Hub → Device sign-in), chat
   freshness, and that `hubSync.v2Cursor` advances (diagnostics log:
   `hub-sse` lines).
2. **48 h watch**, then fleet via the auto-update feed (Windows-only
   auto-update; **macOS machines update manually** — download and replace
   the app bundle, `updater.ts:19-21`).
3. **Per-machine stream fallback**: if v2 SSE misbehaves on a machine, set
   `"hubSyncProtocol": "v1"` in that machine's settings store (no UI —
   deliberate; no rebuild needed) and diagnose before proceeding. The v1
   path and the flag are deleted in the release after fleet confirmation.
4. **Exit checks** (stage-24 §5): fleet on the new version; zero desktop v1
   SSE connections server-side; direct-mode grep gate; read-gateway volume
   unchanged per machine; one week of unchanged chat freshness.
