// The live config write path (Stage B1), shared by the owner console
// (PATCH / DELETE /api/v1/admin/config) and the audited CLI (`config set|clear`).
// Both callers run the SAME allowlist, the SAME validateConfigOverride gate (which
// rejects, never clamps, a key like the Fansly pause that opts into
// `outOfRange: 'reject'`), the SAME transition hooks, the SAME cost-warning audit
// note, the SAME repository writer (config_settings + config_audit_log in one
// transaction), the SAME `audit_events` row and the SAME ramp-gate wake-up. Only
// the actor differs: an owner session (`source: 'api'`) or the CLI (`source: 'cli'`,
// no user). Nothing here decides who may call it — the route checks `requireOwner`,
// and the CLI needs a shell in the api container (DATABASE_URL and the app key).

import { randomUUID } from "node:crypto";

import {
  clearConfigOverride,
  getConfigOverrides,
  listConfigAudit,
  listFanslyPages,
  // The row-level writer, distinct from the same-named sync-control service (which
  // resolves a page by label and enqueues a pg-boss wakeup for a whole scope).
  requestPageSync as requestPageSyncRows,
  setConfigOverridesAtomic,
  type AtomicConfigPatch,
  type SyncStream,
} from "@agency_hub_core/db";
import {
  collectCostWarnings,
  getDescriptor,
  validateAiTranscriptFreshUnionModeTransition,
  validateCaptureCasReadModeTransition,
  validateConfigOverride,
  type ConfigOverrideValue,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { recordAudit, type AuditContext } from "./auth.ts";
import { applyEffectiveOverrides, LIVE_CONFIG_KEYS, loadEffectiveConfig } from "./effective-config.ts";
import { BadRequestError } from "./errors.ts";
import {
  evaluateFanslyStreamGate,
  FANSLY_GATE_CONFIG_KEYS,
  GATED_FANSLY_STREAMS,
  type FanslyStreamGateState,
} from "./sync/fansly-stream-gate.ts";

/** Gate verdict per (page, gated stream) at one instant, plus the pages it was
 *  computed over. Two of these — one from before the config write, one from after
 *  — are what makes the wake-up a TRANSITION detector rather than a "queue
 *  everything currently open" sweep. */
interface FanslyGateSnapshot {
  states: Map<string, FanslyStreamGateState>;
  pages: Array<{ id: number; label: string }>;
}

function gateStateKey(pageId: number, stream: SyncStream) {
  return `${pageId}:${stream}`;
}

async function captureFanslyGateStates(appContext: AppContext): Promise<FanslyGateSnapshot> {
  const effective = await loadEffectiveConfig(appContext.db, appContext.config);
  // listFanslyPages is the repository's active-page listing (platform = 'fansly'
  // and status = 'active'); a tombstoned page must never be woken.
  const pages = await listFanslyPages(appContext.db);
  const states = new Map<string, FanslyStreamGateState>();
  for (const page of pages) {
    for (const gated of GATED_FANSLY_STREAMS) {
      states.set(
        gateStateKey(page.id, gated.stream),
        evaluateFanslyStreamGate(effective, gated.stream, page.label).state,
      );
    }
  }
  return { states, pages: pages.map((page) => ({ id: page.id, label: page.label })) };
}

/** Opening a ramp gate used to change nothing until the stream's next slot, and
 *  fan_earnings runs once a day — so restoring an allowlist entry left the page
 *  frozen for up to 24 more hours (manual "sync all" deliberately skips bulk
 *  streams). Queue the newly allowed streams instead; the planner's minutely tick
 *  dispatches them, so recovery starts within a minute rather than within a day.
 *
 *  ONLY a non-ramped -> ramped transition counts. A gated fan_earnings walk costs
 *  two Fansly calls PER FAN and restarts from cursor 0 once a walk completes, so on
 *  a page the size of lora-1 an unwanted wake-up is ~1400 unscheduled requests
 *  against a platform where the failure mode is a model ban. Closing a gate,
 *  narrowing the allowlist around pages that stay open, or re-writing the same
 *  value therefore must generate no traffic at all. */
async function requestGatedStreamWakeup(
  appContext: AppContext,
  before: FanslyGateSnapshot,
): Promise<void> {
  const after = await captureFanslyGateStates(appContext);
  for (const page of after.pages) {
    const streams: SyncStream[] = [];
    for (const gated of GATED_FANSLY_STREAMS) {
      const key = gateStateKey(page.id, gated.stream);
      if (after.states.get(key) !== "ramped") continue;
      // Already open before the write: nothing was lifted, so nothing to catch up on.
      // A page created between the two snapshots is missing from `before` and so
      // counts as newly opened and gets queued. That is the traffic-spending
      // direction, not the safe one; it is accepted because the window is the few
      // milliseconds inside one request, and a page that young has just been seeded
      // with its own recovery request anyway.
      if (before.states.get(key) === "ramped") continue;
      streams.push(gated.stream);
    }
    if (streams.length === 0) continue;
    // dependencyOptions is deliberately not passed: it only relaxes the OnlyFans
    // OFAPI DM dependency graph, and every page on this path is Fansly.
    await requestPageSyncRows(appContext.db, {
      pageId: page.id,
      streams,
      source: "recovery",
    });
  }
}

/** Snapshot the gate BEFORE the config write, but only when the write can move it.
 *  Returns null when there is nothing to compare against, which also switches the
 *  post-write half off. A failure here is logged and downgraded to "no wake-up":
 *  the config write must not depend on it. */
async function captureGateStatesForConfigChange(
  appContext: AppContext,
  changedKeys: readonly string[],
): Promise<FanslyGateSnapshot | null> {
  if (!changedKeys.some((key) => FANSLY_GATE_CONFIG_KEYS.has(key))) {
    return null;
  }
  try {
    return await captureFanslyGateStates(appContext);
  } catch (error) {
    appContext.logger.warn(
      { err: error, changedKeys },
      "pre-change ramp-gate snapshot failed; skipping the stream wake-up",
    );
    return null;
  }
}

/** Fire-and-log wrapper for the config handlers. The override is already applied
 *  AND audited by the time this runs, so a failure here must never turn a
 *  successful PATCH/DELETE into an error: the wake-up is a convenience that saves
 *  a day of waiting, not part of the write. */
async function wakeGatedStreamsAfterConfigChange(
  appContext: AppContext,
  before: FanslyGateSnapshot | null,
): Promise<void> {
  if (before === null) {
    return;
  }
  try {
    await requestGatedStreamWakeup(appContext, before);
  } catch (error) {
    appContext.logger.warn(
      { err: error },
      "ramp-gate stream wake-up failed after a config change; the config change itself stands",
    );
  }
}

/** The live editing path rejects any key that is not wired to the runtime overlay
 *  (`runtimeApply === 'live'`), so an override can never be written for a key the
 *  runtime would not actually apply without a restart. Still required to be
 *  `editable` (the policy class) — staged/boot flags use the separate staged endpoint. */
export function assertLiveEditableConfigKey(key: string) {
  if (!LIVE_CONFIG_KEYS.has(key)) {
    throw new BadRequestError(`Config key is not runtime-editable: ${key}`);
  }
  const descriptor = getDescriptor(key);
  if (!descriptor) {
    throw new BadRequestError(`Unknown config key: ${key}`);
  }
  if (descriptor.editability !== "editable") {
    throw new BadRequestError(`Config key is not editable: ${key}`);
  }
  if (descriptor.runtimeApply !== "live") {
    throw new BadRequestError(`Config key does not apply at runtime: ${key}`);
  }
}

/** DELETE clears ONLY an `editability === 'editable'` override (a stuck editable knob —
 *  including a non-live editable tunable like ofapiDmDailyCreditBudget). It rejects
 *  'staged' and 'never' keys: a staged (boot) flag is reverted to env exclusively via the
 *  staged endpoint (`desired: null`), which enforces the mandatory expectedVersion + ack
 *  and the order/disable rules — the generic DELETE would bypass all of that.
 *  W8.2 (A32, #133): every `runtimeApply === 'boot'` key is excluded too — a couple of
 *  boot flags are `editable` (ofapiChargebacksReconcileEnabled, ofapiFanIdentitiesSyncEnabled),
 *  and clearing one here would bypass the same staged ritual the editability check protects. */
export function assertClearableConfigKey(key: string) {
  const descriptor = getDescriptor(key);
  if (!descriptor) {
    throw new BadRequestError(`Unknown config key: ${key}`);
  }
  if (descriptor.editability !== "editable") {
    throw new BadRequestError(`Config key is not editable: ${key}`);
  }
  if (descriptor.runtimeApply === "boot") {
    throw new BadRequestError(`Config key is boot-applied; revert it via the staged endpoint: ${key}`);
  }
}

export interface LiveConfigPatchInput {
  key: string;
  /** Raw, not yet validated: whatever the client or the command line sent. */
  value: unknown;
  expectedVersion?: number | undefined;
}

/** Validate every key/value up front so a bad entry rejects the whole patch before
 *  anything is written (BadRequestError carries the validator's message verbatim).
 *  Returns the patches the atomic writer persists: the validated value (CLAMPED for a
 *  clamp-mode key, so processes and UI agree), plus the transition hook a staged-mode
 *  key pins. */
export function validateLiveConfigPatches(patches: readonly LiveConfigPatchInput[]): AtomicConfigPatch[] {
  // A key may appear at most once per patch — duplicates would double-audit / double-
  // bump the version (or self-conflict) inside the atomic apply.
  const keys = patches.map((patch) => patch.key);
  if (new Set(keys).size !== keys.length) {
    throw new BadRequestError("A patch may not set the same key twice");
  }
  return patches.map((patch) => {
    assertLiveEditableConfigKey(patch.key);
    const validated = validateConfigOverride(patch.key, patch.value);
    if (!validated.ok) {
      throw new BadRequestError(validated.error);
    }
    // Staged-mode flags pin a transition rule (stepwise up, any rollback),
    // checked against the CURRENT row value inside the same locked tx that
    // writes the override: fast-reply freshness PR3's union mode, and G5
    // slice 2's capture read mode, which follows it deliberately — a flag
    // that moves the byte source of a read must pass through a shadow window.
    const validateTransition = patch.key === "aiTranscriptFreshUnionMode"
      ? (current: ConfigOverrideValue | null) =>
        validateAiTranscriptFreshUnionModeTransition(current, String(validated.value))
      : patch.key === "captureCasReadMode"
      ? (current: ConfigOverrideValue | null) =>
        validateCaptureCasReadModeTransition(current, String(validated.value))
      : undefined;
    return {
      key: patch.key,
      value: validated.value,
      ...(patch.expectedVersion !== undefined ? { expectedVersion: patch.expectedVersion } : {}),
      ...(validateTransition ? { validateTransition } : {}),
    };
  });
}

/** Fold the patched keys' descriptor costWarnings into the audit note so the warning that
 *  applied is durable evidence. The live path has no ack gate (unlike staged), so this is
 *  its only durable cost record; derived from the registry server-side, never the client. */
export function buildLiveConfigAuditNote(keys: readonly string[], note: string | undefined): string | undefined {
  const costWarnings = collectCostWarnings(keys);
  return Object.keys(costWarnings).length > 0
    ? `${note ? `${note} ` : ""}[cost-warnings] ${Object.entries(costWarnings)
        .map(([key, warning]) => `${key}: ${warning}`)
        .join("; ")}`
    : note;
}

export interface LiveConfigActor {
  /** `config_audit_log.user_id`: the owner's id, or null for the CLI. */
  userId: number | null;
  /** The `audit_events` actor (source api / cli). */
  audit: AuditContext;
}

/** Validate, write (config_settings + config_audit_log, all-or-nothing), record
 *  `admin.config_update` and wake newly opened gated streams. Rejections surface as
 *  BadRequestError; ConfigOverrideVersionConflictError / ConfigOverrideTransitionError
 *  propagate for the caller to map (409 / 400 on the route). */
export async function applyLiveConfigPatches(
  app: AppContext,
  input: { patches: readonly LiveConfigPatchInput[]; note?: string | undefined; actor: LiveConfigActor },
): Promise<Array<{ key: string; value: ConfigOverrideValue; version: number }>> {
  const validatedPatches = validateLiveConfigPatches(input.patches);
  const keys = validatedPatches.map((patch) => patch.key);
  const auditNote = buildLiveConfigAuditNote(keys, input.note);

  // Read the ramp gate BEFORE the write so the wake-up below can queue only the
  // (page, stream) pairs that actually went from gated to ramped. Null when no
  // gate key is in this patch. Every key is already validated at this point, so a
  // rejected patch never reaches here.
  const gateBefore = await captureGateStatesForConfigChange(app, keys);

  // One transaction, all-or-nothing: a conflict on any key rolls back every key.
  const results = await setConfigOverridesAtomic(app.db, {
    patches: validatedPatches,
    userId: input.actor.userId,
    ...(auditNote !== undefined ? { note: auditNote } : {}),
    groupId: randomUUID(),
  });
  await recordAudit(app, {
    ...input.actor.audit,
    eventType: "admin.config_update",
    metadata: {
      keys: results.map((result) => ({ key: result.key, version: result.version })),
      note: auditNote ?? null,
    },
  });
  // Lifting a ramp gate (allowlist widened, stream flag flipped on) must not wait
  // for the stream's next slot — fan_earnings ticks once a day. Never throws.
  await wakeGatedStreamsAfterConfigChange(app, gateBefore);
  // The live path only ever sends upserts (never a clear), so every result carries a
  // non-null value/version — narrow the atomic writer's (nullable) shape back.
  return results as Array<{ key: string; value: ConfigOverrideValue; version: number }>;
}

/** Clear an override (revert to the env value), audited in config_audit_log and as
 *  `admin.config_clear`, then wake newly opened gated streams (clearing an allowlist
 *  override is exactly the "restore every page" case). A version conflict propagates. */
export async function clearLiveConfigOverride(
  app: AppContext,
  input: { key: string; expectedVersion?: number | undefined; note?: string | undefined; actor: LiveConfigActor },
): Promise<void> {
  assertClearableConfigKey(input.key);

  // Same before/after pairing as the patch path — see captureGateStatesForConfigChange.
  const gateBefore = await captureGateStatesForConfigChange(app, [input.key]);

  await clearConfigOverride(app.db, {
    key: input.key,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    userId: input.actor.userId,
    ...(input.note !== undefined ? { note: input.note } : {}),
    groupId: randomUUID(),
  });
  await recordAudit(app, {
    ...input.actor.audit,
    eventType: "admin.config_clear",
    metadata: { key: input.key, note: input.note ?? null },
  });
  await wakeGatedStreamsAfterConfigChange(app, gateBefore);
}

/** The command line hands every value over as a string; turn it into the type the
 *  key's descriptor declares, and leave anything that does not parse as the raw string
 *  so validateConfigOverride rejects it with its usual message ("expects a finite
 *  number", "expects a boolean"). No bound or range is checked here — that stays in the
 *  one shared validator. */
export function parseLiveConfigCliValue(key: string, raw: string): unknown {
  const kind = getDescriptor(key)?.kind;
  if (kind === "number") {
    const trimmed = raw.trim();
    return /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trimmed) ? Number(trimmed) : raw;
  }
  if (kind === "boolean") {
    if (raw.trim() === "true") return true;
    if (raw.trim() === "false") return false;
    return raw;
  }
  return raw;
}

export interface LiveConfigKeyState {
  key: string;
  envName: string;
  /** The process env value (before any override). */
  env: ConfigOverrideValue | null;
  /** The stored override, or null when the key runs on its env value. */
  override: { value: ConfigOverrideValue; version: number } | null;
  /** Why the live overlay ignores the stored override (e.g. a hand-written value outside
   *  a reject-mode range), or null when it applies or there is none. */
  overrideIgnoredReason: string | null;
  /** What a process reading the key right now gets (loadEffectiveConfig). */
  effective: ConfigOverrideValue | null;
  /** The newest config_audit_log row for the key, if any. */
  lastChange: { changedAt: Date; userId: number | null; note: string | null } | null;
}

function toScalar(raw: unknown): ConfigOverrideValue | null {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return raw;
  }
  return raw == null ? null : String(raw);
}

/** Read-only view of one live-editable key: env value, stored override, effective value
 *  (the same overlay every read site applies) and the latest audit row. */
export async function describeLiveConfigKey(app: AppContext, key: string): Promise<LiveConfigKeyState> {
  assertLiveEditableConfigKey(key);
  const descriptor = getDescriptor(key)!;
  const field = descriptor.configField as string;
  const envConfig = (app.rawConfig ?? app.config) as unknown as Record<string, unknown>;

  const overrides = await getConfigOverrides(app.db);
  const stored = overrides.get(key) ?? null;
  const validated = stored ? validateConfigOverride(key, stored.value) : null;
  const effective = applyEffectiveOverrides(app.config, overrides) as unknown as Record<string, unknown>;
  const [latest] = await listConfigAudit(app.db, { key, limit: 1 });

  return {
    key,
    envName: descriptor.envName,
    env: toScalar(envConfig[field]),
    override: stored ? { value: stored.value, version: stored.version } : null,
    overrideIgnoredReason: validated && !validated.ok ? validated.error : null,
    effective: toScalar(effective[field]),
    lastChange: latest
      ? { changedAt: latest.changedAt, userId: latest.userId, note: latest.note }
      : null,
  };
}
