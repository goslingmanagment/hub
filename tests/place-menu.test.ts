import { describe, expect, it } from "vitest";
import { PRODUCTS, productsOf } from "../packages/contracts/src/products.ts";
import { screenCommands, searchCommands } from "../packages/ui/src/palette.ts";
import { carriedHref, crossHref, productLinks } from "../packages/ui/src/place.ts";
import { SCREENS, addressApp, appOf, matchScreen, menuItemAt, productMenu, screenVisible } from "../packages/ui/src/screens.ts";
import { CHATTER_SITE_ORIGIN, CONSOLE_ORIGIN } from "../packages/ui/src/sites.ts";

/** Each product's menu from the one table (products plan §2.2–2.3): who sees which item, where it leads, what an address lights. */

const items = (product: "hub" | "workboard", role: string, holds: { newcomer?: boolean } = {}) => {
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
  it("is the owner's: Главная · Ждут вас · Деньги · Фаны · Страницы · Контент · Трафик · Анкеты, then Настройки · Система", () => {
    const menu = productMenu("hub", "owner");
    expect(menu.upper.map((item) => item.label)).toEqual(["Главная", "Ждут вас", "Деньги", "Фаны", "Страницы", "Контент", "Трафик", "Анкеты"]);
    expect(menu.lower.map((item) => item.label)).toEqual(["Настройки", "Система"]);
  });

  it("lists no Workboard screen but «Ждут вас», which opens Workboard's list for now", () => {
    for (const item of items("hub", "owner")) {
      const screen = matchScreen(item.to)?.screen;
      expect(screen, item.to).toBeDefined();
      expect(screenVisible(screen!, "owner"), item.to).toBe(true);
      expect(addressApp(item.to), item.to).toBe(item.app);
      if (item.app === "workboard") expect(item.id).toBe("waiting");
    }
  });

  it("is nobody else's: a team lead and a chatter have no Hub", () => {
    expect(items("hub", "team_lead")).toEqual([]);
    expect(items("hub", "chatter")).toEqual([]);
  });
});

describe("Workboard's menu", () => {
  it("is the owner's and a team lead's own: Ждут вас · Смены · Люди · Кастомы · Что продаёт, the owner also Выплаты", () => {
    expect(items("workboard", "owner").map((item) => item.label)).toEqual(["Ждут вас", "Смены", "Люди", "Кастомы", "Что продаёт", "Выплаты"]);
    expect(items("workboard", "team_lead").map((item) => item.label)).toEqual(["Ждут вас", "Смены", "Люди", "Кастомы", "Что продаёт"]);
  });

  it("gives a chatter «Мои смены» and «Кастомы», «Начало» first only while a step is open", () => {
    expect(items("workboard", "chatter").map((item) => item.id)).toEqual(["my-shifts", "customs"]);
    expect(items("workboard", "chatter", { newcomer: true }).map((item) => item.id)).toEqual(["start", "my-shifts", "customs"]);
  });

  it("leads every role only to Workboard screens it may open", () => {
    for (const role of ["owner", "team_lead", "chatter"]) {
      for (const item of items("workboard", role, { newcomer: true })) {
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
    expect(menuItemAt("/workboard/people/7/access")).toBe("people");
    expect(menuItemAt("/workboard/shifts/17/2026-11-08T16:08")).toBe("shifts");
    expect(menuItemAt("/workboard/sales/price")).toBe("sales");
    expect(menuItemAt("/workboard/waiting")).toBe("waiting");
    expect(menuItemAt("/workboard/customs/C-12")).toBe("customs");
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
    expect(found("team_lead", "выплат", "workboard")).not.toContain("/workboard/payouts");
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
  it("is the owner's alone: every product; a team lead, a chatter and a narrow session have Workboard and no switcher", () => {
    expect(productsOf("owner", false)).toEqual([...PRODUCTS]);
    for (const [role, narrow] of [["owner", true], ["team_lead", false], ["chatter", false]] as const) {
      expect(productsOf(role, narrow)).toEqual(["workboard"]);
      expect(productLinks(productsOf(role, narrow), "workboard", CHATTER_SITE_ORIGIN)).toEqual([]);
    }
  });

  it("ticks the product it is drawn in and crosses to the others in one step", () => {
    const fromWorkboard = productLinks(productsOf("owner", false), "workboard", CHATTER_SITE_ORIGIN);
    expect(fromWorkboard.map((link) => [link.id, link.current, link.quiet])).toEqual([
      ["hub", false, false], ["workboard", true, false], ["contentops", false, false], ["tasks", false, true], ["monitor", false, true],
    ]);
    expect(fromWorkboard.find((link) => link.id === "hub")!.href.startsWith("/api/v1/auth/sso?")).toBe(true);
    expect(fromWorkboard.find((link) => link.id === "workboard")!.href).toBe("/workboard/");
    expect(fromWorkboard.find((link) => link.id === "contentops")!.href).toBe("https://contentops.gosling-agency.ru/auth/hub/start");
    const fromHub = productLinks(productsOf("owner", false), "hub", CONSOLE_ORIGIN);
    expect(fromHub.find((link) => link.id === "hub")!.href).toBe("/");
    expect(fromHub.find((link) => link.id === "workboard")!.href).toContain(encodeURIComponent(`${CHATTER_SITE_ORIGIN}/workboard/`));
  });
});
