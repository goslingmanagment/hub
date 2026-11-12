import { describe, expect, it } from "vitest";
import { screenCommands, searchCommands } from "../packages/ui/src/palette.ts";
import { carriedHref, placeFace } from "../packages/ui/src/place.ts";
import { addressApp, matchScreen, menuItemAt, placeMenu, screenVisible, teamMenu } from "../packages/ui/src/screens.ts";
import { CHATTER_SITE_ORIGIN, CONSOLE_ORIGIN } from "../packages/ui/src/sites.ts";

/** The one menu of the owner's place (ecosystem L1): who sees which item, where it leads, what an address lights. */

const items = (role: string) => {
  const menu = placeMenu(role);
  return [...menu.upper, ...menu.lower];
};

describe("the menu of the owner's place", () => {
  it.each(["owner", "team_lead"])("leads %s only to screens they may open, each in the app that draws it", (role) => {
    for (const item of items(role)) {
      const screen = matchScreen(item.to)?.screen;
      expect(screen, item.to).toBeDefined();
      expect(screenVisible(screen!, role), item.to).toBe(true);
      expect(addressApp(item.to), item.to).toBe(item.app);
    }
  });

  it("gives a team lead no screen of the owner's alone, and the team's screens they may open", () => {
    const lead = items("team_lead");
    const owner = items("owner");
    expect(lead.length).toBeLessThan(owner.length);
    for (const item of lead) expect(matchScreen(item.to)?.screen.ownerOnly ?? false, item.to).toBe(false);
    expect(lead.some((item) => item.app === "workboard" && item.group !== undefined)).toBe(true);
    expect(owner.filter((item) => !lead.some((other) => other.id === item.id)).every((item) => matchScreen(item.to)?.screen.ownerOnly)).toBe(true);
  });

  it("has nothing for a chatter: their menu is Workboard's own, of Workboard's screens for chatters", () => {
    expect(items("chatter")).toEqual([]);
    const own = teamMenu("chatter");
    expect(own.length).toBeGreaterThan(0);
    for (const item of own) {
      expect(item.app).toBe("workboard");
      expect(matchScreen(item.to)?.screen.roles).toContain("chatter");
    }
  });

  it("lists «Начало» to a chatter only while a step is open, first; «Кастомы» to every role", () => {
    const ids = (holds: { newcomer?: boolean }) => teamMenu("chatter", holds).map((item) => item.id);
    expect(ids({})).not.toContain("start");
    expect(ids({ newcomer: true })[0]).toBe("start");
    expect(ids({})).toContain("customs");
    expect(items("team_lead").map((item) => item.id)).toContain("customs");
    expect(items("owner").map((item) => item.id)).not.toContain("start");
  });

  it("lights the item of the screen an address is on, Workboard's deep pages included", () => {
    expect(menuItemAt("/money/transactions")).toBe("money");
    expect(menuItemAt("/workboard/people/7/access")).toBe("people");
    expect(menuItemAt("/workboard/shifts/17/2026-11-08T16:08")).toBe("shifts");
    expect(menuItemAt("/workboard/sales/price")).toBe("sales");
    expect(menuItemAt("/workboard/decisions")).toBe("waiting");
    expect(menuItemAt("/workboard/customs/C-12")).toBe("customs");
    expect(menuItemAt("/pages/mia-1")).toBeNull();
    expect(menuItemAt("/no-such-screen")).toBeNull();
    expect(menuItemAt("/workboard/no-such-screen")).toBeNull();
  });
});

describe("the search of both apps", () => {
  const found = (role: string, query: string) => searchCommands(screenCommands(role), query).flatMap((command) => (command.to === undefined ? [] : [command.to]));

  it("finds a screen of the other app by its name", () => {
    expect(found("owner", "опер")[0]).toBe("/money/transactions");
    expect(found("owner", "смен")).toContain("/workboard/shifts");
  });

  it("finds a team lead only what they may open", () => {
    expect(found("team_lead", "выплат")).not.toContain("/workboard/payouts");
    expect(found("team_lead", "смен")).toContain("/workboard/shifts");
    for (const to of found("team_lead", "")) expect(screenVisible(matchScreen(to)!.screen, "team_lead"), to).toBe(true);
  });
});

describe("a link to the other app", () => {
  const shifts = { to: "/workboard/shifts", app: "workboard" as const };
  const home = { to: "/", app: "console" as const };
  const settings = { to: "/settings/pages", app: "console" as const };

  it("carries the page and the period both apps have", () => {
    expect(carriedHref(shifts, { page: "mia-1", days: 30 })).toBe("/workboard/shifts?page=mia-1&days=30");
    expect(carriedHref(home, { page: "mia-1", days: 30 })).toBe("/?page=mia-1&period=30d");
  });

  it("leaves behind what the screen it opens does not have", () => {
    expect(carriedHref(home, { page: null, days: 14 })).toBe("/");
    expect(carriedHref(settings, { page: "mia-1", days: 30 })).toBe("/settings/pages");
  });
});

describe("the place a session is in", () => {
  it("is the owner's for the owner and a team lead on the console's name, the team's otherwise", () => {
    expect(placeFace({ role: "owner", narrow: false, origin: CONSOLE_ORIGIN })).toBe("place");
    expect(placeFace({ role: "team_lead", narrow: false, origin: "http://localhost:5180" })).toBe("place");
    expect(placeFace({ role: "owner", narrow: false, origin: CHATTER_SITE_ORIGIN })).toBe("team");
    expect(placeFace({ role: "owner", narrow: true, origin: CONSOLE_ORIGIN })).toBe("team");
    expect(placeFace({ role: "chatter", narrow: false, origin: CONSOLE_ORIGIN })).toBe("team");
  });
});
