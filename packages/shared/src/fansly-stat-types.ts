// Fansly statistics type codes → labels (WP-F1, §5 "Shared label modules").
//
// STORAGE ALWAYS HOLDS THE RAW INTEGER (A22-2). This module is a READ-TIME
// label table and nothing else: a future re-derivation is a version bump plus a
// projection rebuild, never a data rewrite. Keying storage by label would merge
// legacy codes into current ones (A22-2 found five such pairs on the wallet
// side); keying against a closed set would DROP every code the set does not
// name. Neither is acceptable, so the code is what is stored.
//
// THE 8-CODE STRUCTURE (§2.1, re-verified against the 2026-08-19 capture: 31
// daily buckets, every bucket carrying the same eight codes):
//
//   family = type - (type % 10)   member = type % 10
//   member 1 → the headline VISIT count the creator's widget shows
//              (interactionTime is 0 in every observed row)
//   member 0 → the dwell-bearing series, with its OWN differing view and
//              uniqueViewer counts
//
// The precise semantic of member 0's counts (impressions vs visits) is
// UNPROVEN. It is labelled `dwell` and nothing more: an invented meaning would
// be indistinguishable from a measured one a year from now.

/** Bumped whenever a mapping below changes. v1 was the superseded
 *  `reference/fansly_api_spec.md` §3.18 map, which claimed 10000/44000/44030
 *  were "not observed" — the census proved otherwise. */
export const FANSLY_STAT_LABEL_VERSION = 2;

/** Profile-datapoint traffic FAMILIES, keyed by the family code. */
export const FANSLY_PROFILE_STAT_FAMILIES: Readonly<Record<number, string>> = Object.freeze({
  10000: "direct_timeline",
  44000: "fyp_promotion",
  44010: "suggestions",
  44030: "search",
});

/** Media-datapoint types (`dataset.datapoints[].stats[].type`). */
export const FANSLY_MEDIA_STAT_TYPES: Readonly<Record<number, string>> = Object.freeze({
  0: "fyp",
  1: "direct",
});

export type FanslyProfileStatMeasure = "visits" | "dwell";

/** `type - (type % 10)` — the family half of a profile stat code. */
export function profileStatFamily(type: number): number {
  return type - (type % 10);
}

/** Member 1 is the UI's visit counter; every other member is the dwell series. */
export function profileStatMeasure(type: number): FanslyProfileStatMeasure {
  return type % 10 === 1 ? "visits" : "dwell";
}

/**
 * `<family>_<measure>` for a KNOWN code, `unknown:<code>` for anything else.
 *
 * THE GUARD ORDER IS THE POINT AND IS PINNED BY A TEST. A new member of a known
 * family — 10002, 44002, 44032 — must return `unknown:<code>`, NOT be absorbed
 * into its family's label by the family lookup. Absorbing it would silently
 * relabel a metric nobody has ever seen as one we understand, and the anomaly
 * (`fansly_stats_unknown_type`) the canonicalizer raises on the same condition
 * would then be the only trace that anything new arrived.
 *
 * Only members 0 and 1 are observed. The membership test comes FIRST; the
 * family lookup only runs for a code that has already passed it.
 */
export function profileStatLabel(type: number): string {
  if (!Number.isSafeInteger(type)) {
    return `unknown:${String(type)}`;
  }
  const member = type % 10;
  if (member !== 0 && member !== 1) {
    return `unknown:${type}`;
  }
  const family = FANSLY_PROFILE_STAT_FAMILIES[profileStatFamily(type)];
  if (family === undefined) {
    return `unknown:${type}`;
  }
  return `${family}_${profileStatMeasure(type)}`;
}

/** `fyp` / `direct`, or `unknown:<code>`. Same rule: the raw code is stored. */
export function mediaStatLabel(type: number): string {
  if (!Number.isSafeInteger(type)) {
    return `unknown:${String(type)}`;
  }
  const label = FANSLY_MEDIA_STAT_TYPES[type];
  return label ?? `unknown:${type}`;
}

/** True when the code is one this label version actually knows. The
 *  canonicalizer raises `fansly_stats_unknown_type` on a false — and writes the
 *  row anyway (A1: an unknown code is journaled and surfaced, never dropped). */
export function isKnownProfileStatType(type: number): boolean {
  return !profileStatLabel(type).startsWith("unknown:");
}

export function isKnownMediaStatType(type: number): boolean {
  return !mediaStatLabel(type).startsWith("unknown:");
}
