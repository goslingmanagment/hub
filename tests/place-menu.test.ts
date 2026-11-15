import { describe, expect, it } from "vitest";
import { PRODUCTS, productsOf } from "../packages/contracts/src/products.ts";
import { screenCommands, searchCommands } from "../packages/ui/src/palette.ts";
import { carriedHref, crossHref, productLinks } from "../packages/ui/src/place.ts";
import { SCREENS, addressApp, appOf, matchScreen, menuItemAt, productMenu, screenVisible } from "../packages/ui/src/screens.ts";
import { CHATTER_SITE_ORIGIN, CONSOLE_ORIGIN } from "../packages/ui/src/sites.ts";

/** Each product's menu from the one table (products plan §2.2–2.3): who sees which item, where it leads, what an address lights. */

const items = (product: "hub" | "workboard", role: string, holds: { newcomer?: boolean; leads?: boolean; money?: boolean; learn?: boolean } = {}) => {
  const menu = productMenu(product, role, holds);
  return [...menu.upper, ...menu.lower];
};

describe("each screen's product", () => {
  it("is Workboard's for every address under /workboard/ and Hub's for every other, and its app draws it", () => {
    for (const screen of SCREENS) {
      expect(screen.product, screen.id).toBe(addressApp(screen.path) === "workboard" ? "workboard" : "hub");
      expect(appOf(screen), screen.id).toBe(addressApp(screen.path));
    }
  });
});

describe("Hub's menu", () => {
  it("is the owner's: Главная · Ждут вас · Деньги · Страницы · Трафик · Анкеты · Люди, then Настройки · Система", () => {
    // «Контент» is ContentOps' since package C2: its «Публикации» and «Статистика» are there.
    const menu = productMenu("hub", "owner");
    expect(menu.upper.map((item) => item.label)).toEqual(["Главная", "Ждут вас", "Деньги", "Страницы", "Трафик", "Анкеты", "Люди"]);
    expect(menu.lower.map((item) => item.label)).toEqual(["Настройки", "Система"]);
  });

  it("lists only Hub's own screens, «Ждут вас» the owner's list in Hub", () => {
    for (const item of items("hub", "owner")) {
      const screen = matchScreen(item.to)?.screen;
      expect(screen, item.to).toBeDefined();
      expect(screenVisible(screen!, "owner"), item.to).toBe(true);
      expect(addressApp(item.to), item.to).toBe(item.app);
      expect(item.app, item.to).toBe("console");
    }
    expect(items("hub", "owner").find((item) => item.id === "waiting")?.to).toBe("/waiting");
  });

  it("is nobody else's: a team lead and a chatter have no Hub", () => {
    expect(items("hub", "team_lead")).toEqual([]);
    expect(items("hub", "chatter")).toEqual([]);
  });
});

describe("Workboard's menu", () => {
  it("is the owner's and a team lead's own: Сегодня · Ждут вас · Смены · Команда · Фаны · Кастомы · Продажи, the owner also Деньги", () => {
    expect(items("workboard", "owner", { leads: true, money: true }).map((item) => item.label)).toEqual(["Сегодня", "Ждут вас", "Смены", "Команда", "Фаны", "Кастомы", "Продажи", "Деньги"]);
    expect(items("workboard", "team_lead", { leads: true }).map((item) => item.label)).toEqual(["Сегодня", "Ждут вас", "Смены", "Команда", "Фаны", "Кастомы", "Продажи"]);
  });

  it("gives a chatter «Сегодня», «Ждут вас», «Смены», «Фаны», «Кастомы» and «Продажи», «Начало» first only while a step is open", () => {
    expect(items("workboard", "chatter").map((item) => item.id)).toEqual(["today", "waiting", "shifts", "fans", "customs", "sales"]);
    expect(items("workboard", "chatter", { newcomer: true }).map((item) => item.id)).toEqual(["start", "today", "waiting", "shifts", "fans", "customs", "sales"]);
    // «Деньги» only while the person's right «видит свои деньги» is on.
    expect(items("workboard", "chatter", { money: true }).map((item) => item.id)).toEqual(["today", "waiting", "shifts", "fans", "customs", "sales", "money"]);
  });

  it("gives «Команда» to a chatter who leads a team by its records, and never to a plain chatter", () => {
    expect(items("workboard", "chatter", { leads: true }).map((item) => item.id)).toEqual(["today", "waiting", "shifts", "team", "fans", "customs", "sales"]);
    expect(items("workboard", "chatter", { newcomer: true }).map((item) => item.id)).not.toContain("team");
  });

  it("leads every role only to Workboard screens it may open", () => {
    for (const role of ["owner", "team_lead", "chatter"]) {
      for (const item of items("workboard", role, { newcomer: true, leads: true })) {
        const screen = matchScreen(item.to)?.screen;
        expect(screen?.product, item.to).toBe("workboard");
        expect(screenVisible(screen!, role), `${role} ${item.to}`).toBe(true);
        expect(item.app).toBe("workboard");
      }
    }
  });

  it("lights the item of the screen an address is on, deep pages and the old «Решения» included", () => {
    expect(menuItemAt("/money/transactions")).toBe("money");
    expect(menuItemAt("/stats/income")).toBe("stats");
    expect(menuItemAt("/workboard/team/7/schedule")).toBe("team");
    expect(menuItemAt("/people/alex/logins")).toBe("people");
    expect(menuItemAt("/workboard/shifts/17/2026-11-08T16:08")).toBe("shifts");
    expect(menuItemAt("/workboard/sales/price")).toBe("sales");
    expect(menuItemAt("/workboard/waiting")).toBe("waiting");
    expect(menuItemAt("/workboard/customs/C-12")).toBe("customs");
    // «Фаны»'s lists and a fan's card light «Фаны».
    expect(menuItemAt("/workboard/fans/subscribers")).toBe("fans");
    expect(menuItemAt("/workboard/fans/mia-1/fansly/7")).toBe("fans");
    expect(menuItemAt("/pages/mia-1")).toBeNull();
    expect(menuItemAt("/no-such-screen")).toBeNull();
    expect(menuItemAt("/workboard/no-such-screen")).toBeNull();
  });
});

describe("each product's search", () => {
  const found = (role: string, query: string, product: "hub" | "workboard") =>
    searchCommands(screenCommands(role, product), query).flatMap((command) => (command.to === undefined ? [] : [command.to]));

  it("finds the product's own screens, never the other's", () => {
    expect(found("owner", "опер", "hub")[0]).toBe("/money/transactions");
    expect(found("owner", "смен", "hub")).not.toContain("/workboard/shifts");
    expect(found("owner", "смен", "workboard")).toContain("/workboard/shifts");
    expect(found("owner", "опер", "workboard")).not.toContain("/money/transactions");
  });

  it("finds a team lead only what they may open", () => {
    expect(found("team_lead", "долги", "workboard")).not.toContain("/workboard/money/debts");
    expect(found("team_lead", "смен", "workboard")).toContain("/workboard/shifts");
    for (const to of found("team_lead", "", "workboard")) expect(screenVisible(matchScreen(to)!.screen, "team_lead"), to).toBe(true);
  });
});

describe("a link to the other product", () => {
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

  it("goes to the product's own name through the one-time hand-off, and stays on one name locally", () => {
    const hop = (target: string, next: string) => `/api/v1/auth/sso?${new URLSearchParams({ to: target, next }).toString()}`;
    expect(crossHref("workboard", "/workboard/waiting", CONSOLE_ORIGIN)).toBe(hop(CHATTER_SITE_ORIGIN, `${CHATTER_SITE_ORIGIN}/workboard/waiting`));
    expect(crossHref("console", "/", CHATTER_SITE_ORIGIN)).toBe(hop(CONSOLE_ORIGIN, `${CONSOLE_ORIGIN}/`));
    expect(crossHref("workboard", "/workboard/waiting", "http://localhost:5180")).toBe("/workboard/waiting");
  });
});

describe("the products' switcher", () => {
  it("is the owner's: every product; a team lead, a chatter and a narrow session have Workboard and no switcher", () => {
    expect(productsOf({ role: "owner", narrow: false })).toEqual([...PRODUCTS]);
    for (const [role, narrow] of [["owner", true], ["team_lead", false], ["chatter", false]] as const) {
      expect(productsOf({ role, narrow })).toEqual(["workboard"]);
      expect(productLinks(productsOf({ role, narrow }), "workboard", CHATTER_SITE_ORIGIN)).toEqual([]);
    }
  });

  it("gives the test team's owner Hub, Workboard and ContentOps, never the outside tools; a content manager ContentOps", () => {
    expect(productsOf({ role: "owner", narrow: false, test: true })).toEqual(["hub", "workboard", "contentops"]);
    expect(productsOf({ role: "chatter", narrow: false, test: true, personRole: "content_manager" })).toEqual(["workboard", "contentops"]);
    // A content manager's own login: ContentOps alone; a chatter who leads customs: Workboard and ContentOps.
    expect(productsOf({ role: "content_manager", narrow: false })).toEqual(["contentops"]);
    expect(productsOf({ role: "chatter", narrow: false, leadsCustoms: true })).toEqual(["workboard", "contentops"]);
    expect(productsOf({ role: "team_lead", narrow: false, test: true, personRole: "team_lead" })).toEqual(["workboard"]);
  });

  it("ticks the product it is drawn in and crosses to the others in one step", () => {
    const fromWorkboard = productLinks(productsOf({ role: "owner", narrow: false }), "workboard", CHATTER_SITE_ORIGIN);
    expect(fromWorkboard.map((link) => [link.id, link.current, link.quiet])).toEqual([
      ["hub", false, false], ["workboard", true, false], ["contentops", false, false], ["tasks", false, true], ["monitor", false, true],
    ]);
    expect(fromWorkboard.find((link) => link.id === "hub")!.href.startsWith("/api/v1/auth/sso?")).toBe(true);
    expect(fromWorkboard.find((link) => link.id === "workboard")!.href).toBe("/workboard/");
    expect(fromWorkboard.find((link) => link.id === "contentops")!.href).toBe("https://contentops.gosling-agency.ru/auth/hub/start");
    const fromHub = productLinks(productsOf({ role: "owner", narrow: false }), "hub", CONSOLE_ORIGIN);
    expect(fromHub.find((link) => link.id === "hub")!.href).toBe("/");
    expect(fromHub.find((link) => link.id === "workboard")!.href).toContain(encodeURIComponent(`${CHATTER_SITE_ORIGIN}/workboard/`));
  });
});
