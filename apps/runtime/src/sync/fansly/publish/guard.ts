import type { FanslyWriteStep } from "@agency_hub_core/db";

import { FANSLY_WITHDRAW_STEPS } from "./commands.ts";

// The guard of a Fansly write (wall posts PR 6, spec §8.3–8.4): whether a
// queued command may be sent now. Read before every request — at the plan,
// and again in the admission's transaction for what the database says — so a
// switch turned off, a page stopped or an approval moved is never outrun by a
// command queued before it.
//
// Creating and uploading needs every switch on: the global `publishingEnabled`
// and the page's own. Taking a scheduled post off the schedule needs neither
// (spec §8.4: what Hub put on the platform can always be withdrawn), but never
// goes while the page is stopped — a stop for a lost login or a Fansly check
// leaves the schedule as it is, and Hub says so (PR 7 tells the stops apart).
// A write leaves only through the page's browser, once it takes writes.

/** How long a write that waits for its page's browser to take writes looks
 *  again. */
export const WRITE_TRANSPORT_RECHECK_MS = 60_000;

export interface WriteGuardInput {
  step: FanslyWriteStep;
  now: Date;
  notBefore: Date;
  notAfter: Date | null;
  /** The global switch (`publishingEnabled`), read live. */
  publishingEnabled: boolean;
  /** The page's own switch and its autostop (`page_publishing_settings`). */
  page: { enabled: boolean; autostopReason: string | null };
  /** The page's sender takes writes now (`PageTransport.canWrite`). */
  transportWrites: boolean;
  /** The route's contract is verified by the stand (`isFanslyWriteSendable`). */
  contractVerified: boolean;
}

export type WriteGuardVerdict =
  | { kind: "go" }
  | { kind: "wait"; until: Date; reason: string }
  /** Never sent: the command ends `refused` with the reason. */
  | { kind: "refuse"; reason: string };

export function writeGuard(input: WriteGuardInput): WriteGuardVerdict {
  if (input.notAfter !== null && input.now.getTime() >= input.notAfter.getTime()) return { kind: "refuse", reason: "window_passed" };
  if (input.page.autostopReason !== null) return { kind: "refuse", reason: `page_stopped:${input.page.autostopReason}` };
  if (!FANSLY_WITHDRAW_STEPS.includes(input.step)) {
    if (!input.publishingEnabled) return { kind: "refuse", reason: "publishing_off" };
    if (!input.page.enabled) return { kind: "refuse", reason: "page_publishing_off" };
  }
  if (!input.contractVerified) return { kind: "refuse", reason: "route_unverified" };
  if (input.now.getTime() < input.notBefore.getTime()) return { kind: "wait", until: input.notBefore, reason: "not_before" };
  if (!input.transportWrites) {
    const recheck = new Date(input.now.getTime() + WRITE_TRANSPORT_RECHECK_MS);
    const until = input.notAfter !== null && input.notAfter.getTime() < recheck.getTime() ? input.notAfter : recheck;
    return { kind: "wait", until, reason: "transport_cannot_write" };
  }
  return { kind: "go" };
}
