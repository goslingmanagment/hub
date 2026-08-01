import type { AgentPlaneReason } from "@agency_hub_core/contracts";
import type { PlaneReadWitness } from "@agency_hub_core/db";

import type { PlaneNotReadReason } from "./epistemics.ts";

/**
 * Per-operation plane bookkeeping.
 *
 * Every operation declares WHICH planes it physically reads. The set is then
 * widened by the caller's claim (see `operationPlanesFor`), and everything in the
 * widened set that produced no witness must explain itself here. There is no
 * "silently omitted plane" state, by construction: the capture array enumerates
 * the whole registry and this table supplies the reason for each absence.
 */

/** The three message stores plus the two evidentiary journal planes. */
export const MESSAGE_PLANES = [
  "message_archive",
  "dm_message_archive",
  "page_dm_messages",
  "page_dm_threads",
  "observations",
  "sync_raw_payloads",
] as const;

export const IDENTITY_PLANES = [
  "fans",
  "page_fans",
  "fan_username_aliases",
  "page_fan_aliases",
] as const;

export const MONEY_PLANES = ["transactions", "fan_spend_daily", "fan_spend_lifetime"] as const;

export const CRM_PLANES = ["fan_notes", "fan_summaries", "fan_profiles", "fan_flags"] as const;

/**
 * Builds the `not_read` explanations for every plane in the set that produced no
 * witness.
 *
 * The default reason is `not_queried_by_this_operation`, which is the honest one
 * for an evidentiary plane the operation never touches. Callers override it where
 * the truth is sharper: `onlyfans_only` for the OF-only archive on a Fansly
 * scope, `not_indexed_for_text_search` for search, `capability_not_granted` for a
 * section the key may not see.
 */
export function planesNotRead(input: {
  operationPlanes: readonly string[];
  witnesses: readonly PlaneReadWitness[];
  overrides?: Readonly<Record<string, { state: "not_read" | "not_indexed"; reason: AgentPlaneReason }>>;
}): PlaneNotReadReason[] {
  const read = new Set(input.witnesses.map((witness) => witness.plane));
  const overrides = input.overrides ?? {};
  const result: PlaneNotReadReason[] = [];
  for (const plane of input.operationPlanes) {
    if (read.has(plane)) {
      continue;
    }
    const override = Object.hasOwn(overrides, plane) ? overrides[plane] : undefined;
    result.push(override
      ? { plane, state: override.state, reason: override.reason }
      : { plane, state: "not_read", reason: "not_queried_by_this_operation" });
  }
  return result;
}
