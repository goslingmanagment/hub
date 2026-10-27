import {
  CLIENT_FAN_MARKS_MAX_POSTS,
  CLIENT_FAN_MARKS_POST_MAX_CHARS,
  type ClientFanMarksQuery,
  type ClientFanMarksResponse,
} from "@agency_hub_core/contracts";
import {
  findCardFan,
  findFanslyBlocklistPosts,
  findPageSummaryByLabel,
  latestFanslyBlocklistReadAt,
  listFanListMemberships,
  readFanListsReadAt,
  type FanListMembershipRow,
  type FanslyBlocklistMatchRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { fanListLabel, isMarkList } from "../sync/fansly/lib/fan-lists-rules.ts";
import { canAccessPage, requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientGrantedPage } from "./client-switches.ts";
import { blocklistHandleKey } from "./fansly-blocklist/handles.ts";

/**
 * Fan marks (`clientFanMarks`, 2026-10-27): two warnings about the open Fansly
 * fan in the chat header.
 *
 * - `lists`: his current memberships in a user list labelled «бомж» on every
 *   active Fansly page of the agency (`fan-lists.poll` reads them every 6 h).
 *   Another page's list shows its page and model, `granted: false` — no more.
 * - `blocklist`: posts of the Telegram group FANSLY BLOCKLIST whose fansly.com
 *   link names him (`services/fansly-blocklist/reader.ts`), by the username the
 *   page shows (the query) or the one Hub holds, exactly, any case.
 *
 * Not only a fan of the asked page: a fan the sync has not linked yet is the
 * one a warning matters for most, and neither answer holds a message or a note
 * of any page. Database only: nothing here asks a platform or queues work.
 */

export const FAN_MARKS_FEATURE = "fan-marks";

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

/** A post's text as the marks show it: at most CLIENT_FAN_MARKS_POST_MAX_CHARS characters, cut with «…». Pure. */
export function blocklistTextOf(text: string): string {
  const chars = [...text.trim()];
  return chars.length > CLIENT_FAN_MARKS_POST_MAX_CHARS
    ? `${chars.slice(0, CLIENT_FAN_MARKS_POST_MAX_CHARS - 1).join("").trimEnd()}…`
    : chars.join("");
}

/** The post in Telegram, for a member of the group. Pure. */
export function blocklistLinkOf(chatId: number, messageId: number): string {
  return `https://t.me/c/${chatId}/${messageId}`;
}

/** The marked lists, the asked page first, then by model (a page without one last), then by page. Pure. */
export function markListsOf(
  rows: readonly FanListMembershipRow[],
  askedPageId: number,
  granted: (pageId: number) => boolean,
): ClientFanMarksResponse["lists"] {
  return rows
    .filter((row) => isMarkList(row.label))
    .sort((a, b) => Number(b.pageId === askedPageId) - Number(a.pageId === askedPageId)
      || Number(a.modelName === null) - Number(b.modelName === null)
      || (a.modelName ?? "").localeCompare(b.modelName ?? "")
      || a.pageLabel.localeCompare(b.pageLabel)
      || a.since.getTime() - b.since.getTime())
    .map((row) => ({
      pageLabel: row.pageLabel,
      modelName: row.modelName,
      granted: granted(row.pageId),
      label: fanListLabel(row.label),
      since: row.since.toISOString(),
    }));
}

function postOf(row: FanslyBlocklistMatchRow): ClientFanMarksResponse["blocklist"][number] {
  return {
    postedAt: row.postedAt.toISOString(),
    text: blocklistTextOf(row.text),
    author: row.authorName,
    link: blocklistLinkOf(row.chatId, row.messageId),
    handle: row.handle,
  };
}

export async function readClientFanMarks(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; query: ClientFanMarksQuery },
): Promise<ClientFanMarksResponse> {
  // A cookie session → 403: the marks are a client's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), FAN_MARKS_FEATURE);
  const empty: ClientFanMarksResponse = {
    pageLabel: page.label, fanRef: input.fanRef, lists: [], blocklist: [], listsReadAt: null, blocklistReadAt: null,
  };
  if (page.platform !== "fansly") return empty;

  const fan = await findCardFan(app.db, "fansly", input.fanRef);
  const memberships = fan === null ? [] : await listFanListMemberships(app.db, fan.id);
  const keys = [input.query.username, fan?.username ?? undefined].flatMap((name) => {
    const key = name === undefined ? null : blocklistHandleKey(name);
    return key === null ? [] : [key];
  });
  const posts = await findFanslyBlocklistPosts(app.db, { handleKeys: keys, limit: CLIENT_FAN_MARKS_MAX_POSTS });
  const readerOn = (app.config.tgReaderSession ?? null) !== null;

  return {
    ...empty,
    lists: markListsOf(memberships, page.id, (pageId) => canAccessPage(principal, pageId)),
    blocklist: posts.map(postOf),
    listsReadAt: iso(await readFanListsReadAt(app.db)),
    blocklistReadAt: readerOn ? iso(await latestFanslyBlocklistReadAt(app.db)) : null,
  };
}
