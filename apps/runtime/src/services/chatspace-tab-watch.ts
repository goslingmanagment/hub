import type { ClientChatspaceTabStateBody, ClientChatspaceTabStateResponse } from "@agency_hub_core/contracts";
import {
  chatspaceTabPagesOf,
  findUserByUsername,
  latestChatspaceTabReport,
  recordChatspaceTabReport,
  type ChatspaceTabReport,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import {
  notifyChatspaceTabIncident,
  resolveChatspaceTabIncident,
  type ChatspaceTabSubKey,
} from "./notification-incidents.ts";

// The always-on ChatSpace tab (apps/chatspace-browser): the hub's OnlyFans
// feed comes from ChatSpace's socket, which lives only while a ChatSpace tab
// with the accounts is open; this one is open on the server all the time.
// Its extension reports once a minute (clientChatspaceTabState): the view it
// sits on and, per OnlyMonster account open in it, whether ChatSpace's socket
// covers it. Only the server's hub user (CHATSPACE_SERVER_USERNAME) is kept.
//
// The API's ops watchdog judges the newest report every minute and moves the
// owner's latches (kind `chatspace_tab`):
//   silent      no report for 5 min — Firefox, the extension or its hub
//               sign-in is down (after the API's own boot grace; a tab
//               that never reported is not set up yet and is not watched);
//   signed_out  the tab is not on ChatSpace for 3 min: on OnlyMonster's
//               sign-in page (onlymonster.ai, where the extension does not
//               run) or gone — a restart of Firefox comes back sooner;
//   in_chat     the tab sits in a fan's chat (it marks chats read);
//   socket      an OnlyFans page the tab once reported covered is not covered
//               for 5 min — its account was closed in the sidebar, or the
//               socket for it is down (one latch per page). A page never
//               reported covered is not judged: the tap reports coverage only
//               once its socket is armed, and that may not happen on every view.
// The tab is never touched from here: a person logs in on its screen.

export const CHATSPACE_TAB_SILENCE_MS = 5 * 60_000;
export const CHATSPACE_TAB_UNCOVERED_MS = 5 * 60_000;
/** A tab away from ChatSpace this long pages: a restart of Firefox (the watchdog's, an update's) comes back sooner. */
export const CHATSPACE_TAB_AWAY_MS = 3 * 60_000;

type WatchApp = Pick<AppContext, "db" | "config" | "logger">;

let serverUser: { username: string; id: number | null; readAt: number } | null = null;
/** Page id → when the watch first found it uncovered (this API process's memory: a restart starts over). */
const uncoveredSince = new Map<number, number>();
/** When the watch first found the tab away from ChatSpace (`AWAY_KEY`), the same memory. */
const AWAY_KEY = 0;
/** Pages the tab reported covered at least once (this API process's memory): only those are judged uncovered. */
const coveredSeen = new Set<number>();
/** How long the server user's id is trusted before it is read again. */
const SERVER_USER_TTL_MS = 5 * 60_000;

/** The server's hub user's id; null — no such user (the tab is not set up). */
async function serverUserId(app: WatchApp, now: number): Promise<number | null> {
  const username = app.config.chatspaceServerUsername ?? "chatspace-server";
  if (serverUser !== null && serverUser.username === username && now - serverUser.readAt < SERVER_USER_TTL_MS) return serverUser.id;
  const user = await findUserByUsername(app.db, username);
  serverUser = { username, id: user === undefined || user.disabledAt !== null ? null : user.id, readAt: now };
  return serverUser.id;
}

/** The route: a device token's report; another user's is answered and dropped. */
export async function recordChatspaceTabState(
  app: AppContext,
  principal: HumanAuthPrincipal,
  body: ClientChatspaceTabStateBody,
): Promise<ClientChatspaceTabStateResponse> {
  // A cookie session → 403: the report is a client's.
  requireApiKeyUser(principal);
  const now = new Date();
  const id = await serverUserId(app, now.getTime());
  if (id === null || principal.user.id !== id) return { recorded: false, serverNow: now.toISOString() };
  await recordChatspaceTabReport(app.db, {
    userId: id,
    instanceId: body.instanceId,
    reportedAt: now,
    extensionVersion: body.extensionVersion,
    route: body.route,
    accounts: body.accounts.map((account) => ({ ...account })),
  });
  return { recorded: true, serverNow: now.toISOString() };
}

export interface ChatspaceTabVerdict {
  /** Each latch and whether its condition holds now; a latch left out is not judged this time. */
  latches: Array<{ subKey: ChatspaceTabSubKey; page: { pageId: number; pageLabel: string } | null; open: boolean; why: string }>;
}

/**
 * The newest report judged at `now`. Pure but for `uncoveredSince` (page id →
 * when it was first judged uncovered, the hub's clock; the caller keeps it
 * between runs). While the tab is silent nothing else is judged (its last
 * word may be stale); while it is signed out the pages are not either (no
 * socket without a session); both keep those latches as they are.
 */
export function judgeChatspaceTab(input: {
  report: ChatspaceTabReport | null;
  pages: ReadonlyArray<{ pageId: number; pageLabel: string }>;
  now: number;
  bootGrace: boolean;
  uncoveredSince: Map<number, number>;
  coveredSeen: Set<number>;
}): ChatspaceTabVerdict {
  const { report, now } = input;
  // A tab that never reported is not set up yet (its extension not signed in as the server's user): nothing to watch.
  if (report === null) return { latches: [] };
  const age = now - report.reportedAt.getTime();
  if (age > CHATSPACE_TAB_SILENCE_MS) {
    // Inside the API's boot grace a stale tab opens nothing (its reports may wait behind this API's restart).
    if (input.bootGrace) return { latches: [] };
    const why = `No report from the server's ChatSpace tab for ${Math.round(age / 60_000)} min (the last: ${report.route}, extension ${report.extensionVersion}): Firefox, the extension or its hub sign-in is down`;
    return { latches: [{ subKey: "silent", page: null, open: true, why }] };
  }
  const latches: ChatspaceTabVerdict["latches"] = [{ subKey: "silent", page: null, open: false, why: "" }];
  // OnlyMonster's sign-in lives on onlymonster.ai, where the extension does not run: a signed-out tab is a tab that
  // left ChatSpace (`none`), as is one that crashed.
  const signedOut = report.route === "sign-in" || report.route === "none";
  // Away for a while, not at once: right after a restart of Firefox the extension may report before ChatSpace's tab is
  // back. `uncoveredSince` holds the instant under AWAY_KEY (no page has id 0).
  if (!signedOut) input.uncoveredSince.delete(AWAY_KEY);
  const awaySince = signedOut ? (input.uncoveredSince.get(AWAY_KEY) ?? now) : null;
  if (awaySince !== null) input.uncoveredSince.set(AWAY_KEY, awaySince);
  if (awaySince === null || now - awaySince >= CHATSPACE_TAB_AWAY_MS) {
    latches.push({ subKey: "signed_out", page: null, open: signedOut, why: report.route === "none"
      ? "The server's Firefox has no ChatSpace tab: it is on OnlyMonster's sign-in page (the session is gone) or the tab crashed"
      : "The server's ChatSpace tab is on OnlyMonster's sign-in page: its session is gone" });
  }
  latches.push({ subKey: "in_chat", page: null, open: report.route === "chat", why: "The server's ChatSpace tab sits in a fan's chat" });
  if (signedOut) return { latches };
  for (const page of input.pages) {
    const accounts = report.accounts.filter((account) => account.pageLabel === page.pageLabel);
    if (accounts.some((account) => account.covered)) {
      input.coveredSeen.add(page.pageId);
      input.uncoveredSince.delete(page.pageId);
      latches.push({ subKey: "socket", page, open: false, why: "" });
      continue;
    }
    // Never covered yet: the tap has not spoken of this page (it says so only once its socket is armed), so there is
    // no socket to call dead — not judged, and a latch left open is closed.
    if (!input.coveredSeen.has(page.pageId)) {
      input.uncoveredSince.delete(page.pageId);
      latches.push({ subKey: "socket", page, open: false, why: "" });
      continue;
    }
    const first = input.uncoveredSince.get(page.pageId) ?? now;
    input.uncoveredSince.set(page.pageId, first);
    if (now - first < CHATSPACE_TAB_UNCOVERED_MS) continue;
    const why = accounts.length === 0
      ? `The account of ${page.pageLabel} is not in the server tab's ChatSpace (not loaded for its OnlyMonster login)`
      : `ChatSpace's socket has not covered ${page.pageLabel} in the server tab for ${Math.round((now - first) / 60_000)} min: its account is not open in the sidebar, or the socket for it is down`;
    latches.push({ subKey: "socket", page, open: true, why });
  }
  return { latches };
}

/** The ops watchdog's leg: one judgement of the tab, its latches moved. Never throws. */
export async function runChatspaceTabWatch(app: WatchApp, options: { now: Date; bootGrace: boolean }): Promise<void> {
  try {
    const id = await serverUserId(app, options.now.getTime());
    if (id === null) return;
    const [report, pages] = await Promise.all([latestChatspaceTabReport(app.db, id), chatspaceTabPagesOf(app.db, id)]);
    const verdict = judgeChatspaceTab({ report, pages, now: options.now.getTime(), bootGrace: options.bootGrace, uncoveredSince, coveredSeen });
    for (const latch of verdict.latches) {
      if (latch.open) {
        await notifyChatspaceTabIncident(app, { subKey: latch.subKey, page: latch.page, errorSummary: latch.why, occurredAt: options.now });
      } else {
        await resolveChatspaceTabIncident(app, { subKey: latch.subKey, page: latch.page, recoveredAt: options.now });
      }
    }
  } catch (error) {
    app.logger.warn({ err: error }, "Ops watchdog: the ChatSpace server tab check failed; its latches stay as they are");
  }
}
