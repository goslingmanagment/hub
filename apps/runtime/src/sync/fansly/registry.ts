import { createEngineRegistry, type EngineRegistry, type EngineResourceSpec } from "../engine/resource.ts";
import type { Metrics } from "../engine/ports.ts";

// ALL Fansly resources of the Sync Engine (plan §5, design §4): one entry per
// resource variant — trigger, period, class, coalescing, SLO, proof, walk,
// the operations it sends and the legacy streams/senders it replaces.
//
// The table is filled resource family by resource family during step 2
// (S2-07a onwards). Until an entry is here the engine has nothing to plan: a
// page in shadow is owned, paced and journaled, and idle.

export const FANSLY_RESOURCE_SPECS: readonly EngineResourceSpec[] = [];

export function createFanslyRegistry(options: { metrics?: Metrics } = {}): EngineRegistry {
  return createEngineRegistry(FANSLY_RESOURCE_SPECS, options);
}
