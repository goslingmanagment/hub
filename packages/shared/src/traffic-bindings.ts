import { businessDateToUtcStart, isValidBusinessDateString, MOSCOW_TIME_ZONE } from "./time.ts";

// OnlyFans traffic sources (plan 2026-10-08, PR 11): "link → channel →
// contractor" with dates. The vocabulary shared by the store (0255), the
// owner's CLI and, later, the API and the campaign_bindings dataset.

export const trafficLinkKinds = ["tracking", "trial"] as const;
export type TrafficLinkKind = (typeof trafficLinkKinds)[number];

/**
 * How much a start date is worth (coordinator's correction П9.7).
 * `confirmed`: the coordinator or the owner confirmed it.
 * `assumed_link_created`: nobody knows it; the link's creation (for a channel
 * → contractor term: its first link's) stands in for it. A reader never shows
 * an assumed start as established.
 */
export const trafficValidFromBases = ["confirmed", "assumed_link_created"] as const;
export type TrafficValidFromBasis = (typeof trafficValidFromBases)[number];

/** The /OS people slug of a contractor (mirrors traffic_contractors_key_check). */
export const TRAFFIC_CONTRACTOR_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** `<model>.<channel>`, e.g. `lora.porntoki` (mirrors traffic_channels_key_check). */
export const TRAFFIC_CHANNEL_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}\.[a-z0-9][a-z0-9_-]{0,63}$/;
/** An OnlyFans link id (mirrors traffic_link_bindings_link_id_check). */
export const TRAFFIC_LINK_ID_PATTERN = /^[0-9]{1,20}$/;

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export function isTrafficLinkKind(value: string): value is TrafficLinkKind {
  return (trafficLinkKinds as readonly string[]).includes(value);
}

export function isTrafficValidFromBasis(value: string): value is TrafficValidFromBasis {
  return (trafficValidFromBases as readonly string[]).includes(value);
}

/**
 * A binding instant as the owner writes it: a bare date `YYYY-MM-DD` is 00:00
 * Europe/Moscow of that day (the business day); anything else must be an ISO
 * instant with an explicit offset or `Z` — a local time without a zone is
 * refused, never guessed.
 */
export function parseTrafficInstant(value: string): Date {
  const text = value.trim();
  if (isValidBusinessDateString(text)) {
    return businessDateToUtcStart(text, MOSCOW_TIME_ZONE);
  }
  if (!ISO_INSTANT_PATTERN.test(text)) {
    throw new Error(
      `Invalid instant "${value}": expected YYYY-MM-DD (00:00 Moscow) or an ISO instant with Z or an offset`,
    );
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid instant "${value}"`);
  }
  return parsed;
}
