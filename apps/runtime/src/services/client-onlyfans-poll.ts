import {
  CLIENT_ONLYFANS_POLL_EVERY_SECONDS,
  CLIENT_ONLYFANS_POLL_MAX_PAGES,
  type ClientOnlyfansPollBody,
  type ClientOnlyfansPollResponse,
} from "@agency_hub_core/contracts";
import { readOnlyfansFeedPoll, recordOnlyfansFeedPollPass, takeOnlyfansFeedPoll, type Database } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireBoundAccount } from "./client-onlyfans-feed.ts";
import { requireClientFeatureOnLabel, type ClientFeatureRequest } from "./client-switches.ts";

/**
 * The page's poll of ChatSpace for the OnlyFans feed (`clientOnlyfansPoll`,
 * capability `onlyfans-poll-v1`, the page's `ofPoll`).
 *
 * The owner allowed the extension light reads of ChatSpace (2026-10-31):
 * ChatSpace's own requests at its own pace — the page's notifications of new
 * subscribers and its sales ledger, which its socket does not carry — the
 * first page of each every CLIENT_ONLYFANS_POLL_EVERY_SECONDS, read back to the
 * newest item the hub holds, never retried. ONE poller a page for the whole
 * team: the hub lends the poll to one tab at a time. The agency's always-on
 * ChatSpace tab (the hub user CHATSPACE_SERVER_USERNAME) is the steady poller:
 * while it asked within SERVER_HOLD_MS only it is lent the poll; when it is
 * gone a chatter's tab takes over. What the poll reads goes through the feed
 * (`clientOnlyfansFeed`), which dedups it with every other sighting.
 *
 * Database only: nothing here asks a platform.
 */

/** The agency's always-on ChatSpace tab's hub user (its own task adds the config; this is its default). */
export const CHATSPACE_SERVER_USERNAME = "chatspace-server";
/** While the always-on tab asked this recently, the page's poll is its alone. */
export const SERVER_HOLD_MS = 15 * 60_000;

export async function applyClientOnlyfansPoll(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; body: ClientOnlyfansPollBody },
): Promise<ClientOnlyfansPollResponse> {
  requireApiKeyUser(principal);
  // The poll feeds the feed: both switches of the page.
  await requireClientFeatureOnLabel(app, request, principal, input.pageLabel, "ofFeed");
  const page = await requireClientFeatureOnLabel(app, request, principal, input.pageLabel, "ofPoll");
  await requireBoundAccount(app, page, input.body);
  const server = principal.user.username === CHATSPACE_SERVER_USERNAME;
  const now = new Date();
  const passed = input.body.passed;
  if (passed !== undefined) {
    // The holder's report of its pass: «Новые» vouch for the page's list by it. Taken only from the holder of a recent
    // grant; it lends nothing, and the answer says when the next poll may be lent.
    await recordOnlyfansFeedPollPass(app.db, { pageId: page.id, userId: principal.user.id, now, holdMs: SERVER_HOLD_MS, passed });
  }
  const lease = await app.db.transaction(async (tx) => passed !== undefined ? readOnlyfansFeedPoll(tx as unknown as Database, page.id, now) : takeOnlyfansFeedPoll(tx as unknown as Database, {
    pageId: page.id,
    userId: principal.user.id,
    server,
    now,
    everyMs: CLIENT_ONLYFANS_POLL_EVERY_SECONDS * 1000,
    serverHoldMs: SERVER_HOLD_MS,
  }));
  return {
    pageLabel: page.label,
    granted: lease.granted,
    holder: lease.holder,
    nextAt: lease.nextAt.toISOString(),
    cursors: lease.cursors,
    maxPages: CLIENT_ONLYFANS_POLL_MAX_PAGES,
    serverNow: now.toISOString(),
  };
}
