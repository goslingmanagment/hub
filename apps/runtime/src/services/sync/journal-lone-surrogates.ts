// Production 2026-09-30 00:06:58 UTC: lilly-2 stats_snapshot run 883014 failed
// with "Error while inserting Fansly discovery_feed raw payload (22P02)",
// Postgres "invalid input syntax for type json. Unicode low surrogate must
// follow a high surrogate". The Fansly body carried an UNPAIRED UTF-16
// surrogate of its own (vendor text such as a bio with an emoji cut in half).
// JSON.stringify writes one as a `\udXXX` escape, and json/jsonb refuse that
// escape, so the raw row failed and the chunk with it, before anything was
// journaled or parsed. That time the retry got a different body. A
// deterministic one (a DM page holding a fan's broken emoji, a caption, a
// comment) fails every retry: the DM breaker would defer and then quarantine
// the thread without ever journaling the message, and any other stream wedges.
//
// The rule is the one decision #132's addendum set for OFAPI derived frames
// (packages/shared/src/unicode.ts): vendor data can carry its own unpaired
// surrogates, and the journal must never wedge on them. A body that holds one
// is journaled as a copy with each unpaired surrogate replaced by U+FFFD, in
// the catalog object and both inline envelopes alike, so the three still agree
// and the catalog copy, which the frozen codec would otherwise escape into
// the same refused jsonb, succeeds and keeps dedup and the pointer-only path
// working. Nothing else changes: a paired surrogate (a whole emoji) is never
// touched, and a body without an unpaired one is written as the very object
// the lane served, with no copy and no marker.
//
// This is a replacement, not an escape, so the original code unit is lost. It
// never carried a character: half of a pair has no meaning on its own and
// every other store (text columns included, which the driver encodes as UTF-8)
// already turns it into U+FFFD. The served object is never mutated either: the
// lane goes on parsing it after the journal write, as before.

import { countLoneSurrogatesDeep, sanitizeLoneSurrogatesDeep } from "@agency_hub_core/shared";

/**
 * Appended to `sync_raw_payloads.mapper_version` when the raw body had any
 * unpaired surrogate replaced, after `+cdn-tokens-stripped-v1` when both
 * apply, so replay tooling can tell a rewritten body from a verbatim one.
 * Observations carry no mapper field; the capture's run note gives both counts.
 */
export const JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX = "+lone-surrogates-replaced-v1";

/** The run note's `details.code`. An info note, never an anomaly: the capture
 *  succeeded and the page is healthy. */
export const JOURNAL_LONE_SURROGATES_REPLACED_NOTE_CODE = "journal_lone_surrogates_replaced";

/**
 * The value to journal in place of `value`, and how many unpaired surrogates
 * that took. With none it is `value` itself (one walk, no copy); otherwise a
 * deep copy, and `value` is left as it was.
 */
export function replaceJournalLoneSurrogates<T>(value: T): { value: T; replaced: number } {
  const replaced = countLoneSurrogatesDeep(value);
  return { value: replaced === 0 ? value : sanitizeLoneSurrogatesDeep(value), replaced };
}
