import { describe, expect, it } from "vitest";

import { resolveLegacyUrl } from "../apps/dashboard/src/lib/redirects.ts";
import { matchScreen, SCREENS, SECTIONS, screenById } from "../apps/dashboard/src/lib/sections.ts";

// A promise to the owner (design/ia.md §8.2): every old address keeps working
// and lands where it always did, with its parameters and its anchor. One row per
// line of that table, in its order.
const REDIRECTS: ReadonlyArray<readonly [number | string, string, string]> = [
  ["money/income", "/money/income?period=30d", "/?period=30d"],
  [2, "/transactions?pageLabel=mia-1&from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z&type=tip&state=posted&sortBy=occurredAt&sortDir=asc&reportableOnly=true&offset=50&backTo=%2F%3Fperiod%3D7d", "/money/transactions?from=2026-10-01T00%3A00%3A00Z&to=2026-10-08T00%3A00%3A00Z&type=tip&state=posted&sortBy=occurredAt&sortDir=asc&reportableOnly=true&offset=50&backTo=%2F%3Fperiod%3D7d&page=mia-1"],
  ["2, no dates: the whole history, every operation", "/transactions?pageLabel=mia-1&type=tip", "/money/transactions?type=tip&page=mia-1&period=all&reportableOnly=false"],
  [3, "/pages", "/settings/pages"],
  [4, "/pages/mia-1?type=tip&txOffset=25", "/money/transactions?type=tip&offset=25&page=mia-1&period=all&reportableOnly=false"],
  ["4, its old period was another block's", "/pages/mia-1?period=30d&type=tip", "/money/transactions?period=all&type=tip&page=mia-1&reportableOnly=false"],
  [5, "/pages/mia-1/subscribers?filter=norenew&query=ann&offset=50&backTo=%2F", "/fans/subscribers?filter=norenew&query=ann&offset=50&backTo=%2F&page=mia-1"],
  [6, "/pages/mia-1/followers?filter=new24h", "/fans/followers?filter=new24h&page=mia-1"],
  [7, "/pages/mia-1/top-supporters?filter=cooling&q=ann&sortBy=username&dir=asc&period=90d&offset=50", "/fans?filter=cooling&q=ann&sortBy=username&dir=asc&period=90d&offset=50&page=mia-1"],
  [8, "/pages/mia-1/deleted-fans?offset=50", "/fans/gone?offset=50&page=mia-1"],
  [9, "/pages/mia-1/profile", "/pages/mia-1/account"],
  [10, "/pages/mia-1/settings", "/pages/mia-1/account#fansly-settings"],
  [11, "/pages/mia-1/spender-autolists/600-plus?period=all&followersOnly=true&query=a&offset=50", "/fans/by-spend/600-plus?period=all&followersOnly=true&query=a&offset=50&page=mia-1"],
  [12, "/pages/mia-1/fans/fansly/7409?period=30d", "/fans/mia-1/fansly/7409?period=30d"],
  [13, "/browser-profiles/new?page=mia-1&name=draft", "/settings/pages/connect?name=draft&forPage=mia-1"],
  [14, "/browser-profiles/abc", "/settings/pages/connect/abc"],
  [15, "/ofapi-marketing?page=mia-of", "/pages/mia-of/promo"],
  [16, "/ofapi-marketing", "/system/onlyfans-api"],
  [17, "/ofapi-media", "/system/onlyfans-api/media"],
  [18, "/ofapi-exports", "/system/onlyfans-api/exports"],
  [19, "/ofapi-actions", "/system/onlyfans-api/actions"],
  [20, "/ofapi-credits", "/money/costs/onlyfans-api"],
  [21, "/usage", "/money/costs/ai"],
  [22, "/ai-spend", "/money/costs/ai"],
  [23, "/publication-settings", "/publications?panel=settings"],
  [24, "/team", "/team/shifts"],
  [25, "/team/authors?days=1", "/team/shifts?period=24h#authors"],
  ["25, 3 days", "/team/authors?days=3", "/team/shifts?period=3d#authors"],
  ["25, no days", "/team/authors", "/team/shifts?period=7d#authors"],
  [26, "/team/approaches?days=90", "/team/win-back?period=90d"],
  [27, "/team/numbers", "/team/chatters"],
  [28, "/team/shift-reports", "/team/payouts"],
  [29, "/team/chatter-stats?user=7&days=14", "/team/chatters/7?period=14d"],
  [30, "/team/chatter-stats?days=30", "/team/chatters?period=30d"],
  [31, "/held-sends?state=resolved&page=mia-of&offset=25", "/team/held-sends?state=resolved&page=mia-of&offset=25"],
  [32, "/agent-hydration", "/system/history-requests"],
  [33, "/incidents", "/system/failures"],
  [34, "/analytics?page=mia-1&range=90d", "/stats?page=mia-1&period=90d"],
  [35, "/stats?tab=overview&days=30&page=mia-1", "/stats?page=mia-1&period=30d"],
  [36, "/stats?tab=content&days=7", "/stats/content?period=7d"],
  [37, "/stats?tab=audience&page=mia-1", "/stats/audience?page=mia-1"],
  [38, "/stats?days=180", "/stats?period=180d"],
  [39, "/notifications?tab=incidents", "/system/failures"],
  [40, "/notifications?tab=telegram", "/settings/notifications"],
  [41, "/settings", "/settings/pages"],
  ["41, unknown tab", "/settings?tab=whatever", "/settings/pages"],
  [42, "/settings?tab=pages&page=mia-1", "/settings/pages"],
  [43, "/settings?tab=models", "/settings/pages"],
  [44, "/settings?tab=credentials", "/settings/pages"],
  [45, "/settings?tab=users", "/team/people"],
  [46, "/settings?tab=personas", "/settings/ai/personas"],
  [47, "/settings?tab=collection", "/system/onlyfans-api/collection"],
  [48, "/settings?tab=notifications", "/settings/notifications"],
  [49, "/settings?tab=engine", "/system/collection"],
  [50, "/settings?tab=engine&page=mia-1", "/system/collection/mia-1"],
  [51, "/settings?tab=sync", "/system/collection"],
  [52, "/settings?tab=sync&page=mia-of", "/system/collection/mia-of"],
  [53, "/settings?tab=ofapi", "/system/onlyfans-api/tools"],
  [54, "/settings?tab=features&feature=voice&view=all&q=a", "/settings/ai/features?feature=voice&view=all&q=a"],
  [55, "/settings?tab=configuration#config-publishingEnabled", "/system/dev/config#config-publishingEnabled"],
  [56, "/settings?tab=configuration&feature=voice&view=review&q=a#config-voiceNotesEnabled", "/settings/ai/features/voice?view=review&q=a#config-voiceNotesEnabled"],
  [57, "/settings?tab=agentKeys", "/system/agent-keys"],
  [58, "/dev", "/system/dev/log"],
  [59, "/dev/log", "/system/dev/log"],
  [60, "/dev/queue", "/system/dev/queue"],
  [61, "/dev/db-stats", "/system/dev/database"],
  [62, "/dev/incidents", "/system/dev/log?problems=1"],
  [63, "/dev/sync-status?runId=42", "/system/dev/log/42"],
  [64, "/dev/sync-status", "/system/dev/log"],
  ["7.1, row 50", "/dev/client-health", "/system/dev/extension"],
  [65, "/money", "/money/costs/ai"],
  [66, "/money/costs", "/money/costs/ai"],
  [67, "/settings/ai", "/settings/ai/personas"],
  [68, "/system", "/system/collection"],
  [69, "/system/dev", "/system/dev/log"],
];

describe("old addresses (design/ia.md §8.2)", () => {
  it.each(REDIRECTS)("row %s: %s lands on %s", (_row, from, to) => {
    expect(resolveLegacyUrl(from)).toBe(to);
  });

  it("carries a parameter it does not know", () => {
    expect(resolveLegacyUrl("/ofapi-credits?unknown=1")).toBe("/money/costs/onlyfans-api?unknown=1");
  });

  it("encodes a page's label in the new path", () => {
    expect(resolveLegacyUrl("/pages/a%20b/profile")).toBe("/pages/a%20b/account");
    expect(resolveLegacyUrl("/settings?tab=engine&page=a%2Fb")).toBe("/system/collection/a%2Fb");
  });

  it.each(["/", "/?period=30d", "/?row=mia-1&chart=page:mia-1&sort=decline&period=30d", "/stats", "/stats?period=30d&page=mia-1", "/pages/mia-1", "/pages/mia-1?period=7d", "/pages/mia-1/promo", "/publications?page=mia-1&status=draft&window=all", "/team/customs", "/account", "/join", "/login"])(
    "leaves %s where it is",
    (url) => {
      expect(resolveLegacyUrl(url)).toBeNull();
    },
  );

  it("every target is a screen of the console", () => {
    for (const [row, , to] of REDIRECTS) {
      const pathname = new URL(to, "https://hub.invalid").pathname;
      expect(matchScreen(pathname), `row ${row}: ${to}`).not.toBeNull();
    }
  });
});

describe("the table of screens", () => {
  it("names only screens that exist, each in one tab", () => {
    const seen = new Set<string>();
    for (const section of SECTIONS) {
      for (const tab of section.tabs) {
        for (const id of tab.screens) {
          expect(screenById(id).section).toBe(section.id);
          expect(seen.has(id), id).toBe(false);
          seen.add(id);
        }
      }
    }
    const orphans = SCREENS.filter((screen) => screen.section !== "page" && !seen.has(screen.id)).map((screen) => screen.id);
    expect(orphans).toEqual([]);
  });

  it("gives each address its own screen", () => {
    for (const screen of SCREENS) {
      const concrete = screen.path.replace(/:[A-Za-z]+/g, "x");
      expect(matchScreen(concrete)?.screen.id, screen.path).toBe(screen.id);
    }
  });
});
