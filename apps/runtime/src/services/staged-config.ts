// Pure, framework-free order validator for staged-rollout (Stage C) flag flips. The
// staged endpoint runs every flip through `validateStagedTransition` before persisting,
// so the prescribed enable order (the registry `requires` chain) is enforced against the
// APPLIED (running) state, not merely the desired state: a prerequisite must be RUNNING
// (restarted/applied) before the next step can be unlocked. Keeping it pure means the
// ordering rules are unit-testable without a database or a live process.

import { sql } from "drizzle-orm";

import type { ConfigOverrideValue } from "@agency_hub_core/shared";
import { CONFIG_DESCRIPTORS, getDescriptor, transitiveRequires } from "@agency_hub_core/shared";
import type { Database } from "@agency_hub_core/db";
import {
  applyConfigPatchesInTx,
  getConfigOverrides,
  listActiveInstances,
  type AtomicConfigPatch,
} from "@agency_hub_core/db";

import { BadRequestError } from "./errors.ts";
import { getRunningFlagState } from "./app-config-service.ts";

export type RunningFlagState = "on" | "off" | "unknown";

export interface StagedPatchEntry {
  key: string;
  desired: boolean;
}

export interface ValidateStagedTransitionInput {
  /** Explicit desired booleans for the keys being flipped in this patch. */
  patches: StagedPatchEntry[];
  /** APPLIED truth for a key across active instances (getRunningFlagState). */
  runningState: (key: string) => RunningFlagState;
  /** The CURRENT desired-on baseline for a key not present in this patch: its stored DB
   *  override boolean when one exists, else the raw env value. NOT the boot-applied
   *  config (which is stale relative to later DB writes) — using the DB desired baseline
   *  is what makes a staged-but-not-restarted override visible to the disable check. */
  baselineDesiredOn: (key: string) => boolean;
}

export type ValidateStagedTransitionResult = { ok: true } | { ok: false; error: string };

/** Every boot descriptor key that (transitively) requires `key` — i.e. the keys that
 *  must NOT remain desired-on if `key` is being disabled. */
function transitiveDependents(key: string): string[] {
  return CONFIG_DESCRIPTORS.filter(
    (descriptor) =>
      descriptor.runtimeApply === "boot" && transitiveRequires(descriptor.key).includes(key),
  ).map((descriptor) => descriptor.key);
}

/** PURE validation of a staged transition. Rules (see the Stage C brief):
 *   1. Every patched key must be a boot (`runtimeApply === 'boot'`) descriptor, and no
 *      key may appear twice.
 *   2. Compute the RESULTING desired graph: a flag is desired-on after this patch if its
 *      patch sets it true, or (when not in the patch) its current desired baseline
 *      (`baselineDesiredOn` — the DB override boolean, else env) is on.
 *   3. ENABLE (desired true): every key in the transitive `requires` chain must be
 *      RUNNING-on (`runningState === 'on'`) — not merely desired. Enabling a prerequisite
 *      in the SAME patch does NOT satisfy it (it is not running yet) → reject.
 *   4. DISABLE (desired false): no key that transitively requires it may remain desired-on
 *      after this patch. Disabling a dependent + its prerequisite together in one patch is
 *      allowed (validated on the resulting graph, not one entry at a time).
 *  Returns a precise error naming the offending key + reason on the first violation. */
export function validateStagedTransition(
  input: ValidateStagedTransitionInput,
): ValidateStagedTransitionResult {
  const { patches, runningState, baselineDesiredOn } = input;

  // Rule 1: boot-only keys, no duplicates.
  const seen = new Set<string>();
  for (const patch of patches) {
    if (seen.has(patch.key)) {
      return { ok: false, error: `A staged patch may not set the same key twice: ${patch.key}` };
    }
    seen.add(patch.key);
    const descriptor = getDescriptor(patch.key);
    if (!descriptor) {
      return { ok: false, error: `Unknown config key: ${patch.key}` };
    }
    if (descriptor.runtimeApply !== "boot") {
      return { ok: false, error: `Config key is not staged (boot-applied): ${patch.key}` };
    }
  }

  const patchByKey = new Map(patches.map((patch) => [patch.key, patch.desired]));

  // Rule 2: resulting desired-on truth for any boot key after this patch. For a key not
  // in the patch this is the CURRENT desired baseline (DB override boolean, else env), so
  // a staged-but-not-restarted override is counted as desired-on by the disable check.
  const desiredOn = (key: string): boolean => {
    const patched = patchByKey.get(key);
    if (patched !== undefined) return patched;
    return baselineDesiredOn(key);
  };

  for (const patch of patches) {
    if (patch.desired) {
      // Rule 3 (ENABLE): every transitive prerequisite must be RUNNING-on now. A prereq
      // being enabled in this same patch does not count — it is not running yet.
      for (const prereq of transitiveRequires(patch.key)) {
        if (runningState(prereq) === "on") continue;
        if (patchByKey.get(prereq) === true) {
          return {
            ok: false,
            error: `Cannot enable ${patch.key}: prerequisite ${prereq} is enabled in the same patch but is not running yet — enable + restart ${prereq} first`,
          };
        }
        const state = runningState(prereq);
        return {
          ok: false,
          error: `Cannot enable ${patch.key}: prerequisite ${prereq} is not running (${state}) — enable + restart ${prereq} first`,
        };
      }
    } else {
      // Rule 4 (DISABLE): no dependent may remain desired-on after this patch.
      for (const dependent of transitiveDependents(patch.key)) {
        if (desiredOn(dependent)) {
          return {
            ok: false,
            error: `Cannot disable ${patch.key}: ${dependent} still depends on it — disable ${dependent} first (or in the same patch)`,
          };
        }
      }
    }
  }

  return { ok: true };
}

// Fixed, transaction-scoped advisory-lock key that serializes ALL staged config mutations
// against each other (a single global mutex; staged flips are rare admin actions). Two
// concurrent staged patches on DIFFERENT keys would otherwise each lock only their own rows
// (setConfigOverridesAtomic FOR UPDATE) and both pass validateStagedTransition, persisting an
// invalid dependent=on/prereq=off graph. Holding this lock for the whole read-validate-write
// makes the staged commit serializable; the live PATCH path does NOT take it (its single-key
// writes are independent and order-irrelevant), so live editing is unaffected. The value is
// an arbitrary fixed bigint (distinct from any other advisory-lock key in the codebase).
export const STAGED_CONFIG_ADVISORY_LOCK_KEY = 6_041_703_182_546_001n;

/** One resolved staged patch as the commit applies it: a boolean upsert (`desired`) or a
 *  revert-to-env clear (`desired: null`). `expectedVersion` carries the optimistic-lock
 *  guard the handler validated up front. */
export interface StagedCommitPatch {
  key: string;
  desired: boolean | null;
  expectedVersion?: number;
}

export interface CommitStagedConfigChangeInput {
  patches: StagedCommitPatch[];
  /** Per-key resolved desired boolean for the order validation: a null (clear) patch is
   *  validated as its env baseline boolean (so reverting an env-off key still runs the
   *  disable-dependent rule). Computed by the handler from rawConfig. Reads only the
   *  key/desired, so it accepts any patch shape carrying them. */
  resolvedDesired: (patch: { key: string; desired: boolean | null }) => boolean;
  /** The PRE-boot-apply env config (rawConfig), the env baseline for a key with no override. */
  rawConfig: Record<string, unknown>;
  userId: number | null;
  /** Structured audit note (ack + operator note) the handler already serialized. */
  note: string;
  groupId: string;
}

/** BLOCKER 1 — the serialized staged read-validate-write-apply. Everything runs in ONE
 *  transaction holding {@link STAGED_CONFIG_ADVISORY_LOCK_KEY} (a transaction-scoped advisory
 *  lock), so no two staged mutations interleave: the baseline + running snapshot are re-read
 *  INSIDE the lock, validateStagedTransition runs against that serialized snapshot, and the
 *  patches apply via applyConfigPatchesInTx — all atomic. A second concurrent staged commit
 *  blocks on the lock, then re-reads the first's persisted override in its baseline and is
 *  rejected if it would orphan a prerequisite. On a validation failure a BadRequestError is
 *  thrown (rolls back, releases the lock → 400); a ConfigOverrideVersionConflictError from the
 *  apply propagates for the handler's 409 mapping. The live PATCH path does NOT take this lock. */
export async function commitStagedConfigChange(
  db: Database,
  input: CommitStagedConfigChangeInput,
): Promise<Array<{ key: string; value: ConfigOverrideValue | null; version: number | null }>> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    // Serialize against every other staged mutation for the rest of this transaction.
    await database.execute(sql`select pg_advisory_xact_lock(${STAGED_CONFIG_ADVISORY_LOCK_KEY})`);

    // Re-read the baseline + running snapshot INSIDE the lock so they reflect a serialized
    // view (any earlier staged commit's override is now visible to this baseline).
    const overrides = await getConfigOverrides(database);
    const activeInstances = await listActiveInstances(database);
    const baselineDesiredOn = (key: string): boolean => {
      const override = overrides.get(key);
      if (override !== undefined) return Boolean(override.value);
      return input.rawConfig[key] === true;
    };

    const transition = validateStagedTransition({
      patches: input.patches.map((patch) => ({ key: patch.key, desired: input.resolvedDesired(patch) })),
      runningState: (key) => getRunningFlagState(activeInstances, key),
      baselineDesiredOn,
    });
    if (!transition.ok) {
      // Throw to roll the transaction back (and release the advisory lock). The handler
      // maps this to a 400 like the up-front per-key validation does.
      throw new BadRequestError(transition.error);
    }

    const patches: AtomicConfigPatch[] = input.patches.map((patch) =>
      patch.desired === null
        ? { key: patch.key, clear: true as const, expectedVersion: patch.expectedVersion }
        : { key: patch.key, value: patch.desired, expectedVersion: patch.expectedVersion },
    );

    return applyConfigPatchesInTx(database, {
      patches,
      userId: input.userId,
      note: input.note,
      groupId: input.groupId,
    });
  });
}
