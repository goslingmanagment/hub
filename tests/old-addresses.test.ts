import { describe, expect, it } from "vitest";

import { teamPeopleInHub, teamToWorkboard } from "../apps/dashboard/src/lib/workboard.ts";
import { signinNamesOf, workboardOnConsoleRedirect, workboardOnFormerTeamRedirect } from "../apps/runtime/src/services/signin-handoff.ts";
import { contentopsAddress, contentScreenOf, pageOf, postOf } from "../apps/runtime/src/services/content-screens-moved.ts";
import { OLD_ADDRESSES, WORKBOARD_OLD_PATHS, registryTabLanding, workboardOldAddress } from "../packages/ui/src/old-addresses.ts";
import { matchScreen } from "../packages/ui/src/screens.ts";
import { hubEntryHref, workboardEntryHref } from "../packages/ui/src/sites.ts";

// Old addresses lead to new ones (products plan §2.3, §7.3): every row of the one table, walked through the layers
// that answer it in production — Hub's server, the console's router, the hand-off, Workboard's router — the way a
// browser follows them (it keeps the `#…` across a server's redirect).

const NAMES = signinNamesOf({ isProduction: true } as Parameters<typeof signinNamesOf>[0]);
const HUB = NAMES.console;
const TEAM = NAMES.team;
const BASE = "/workboard";
const CONTENTOPS = "https://contentops.gosling-agency.ru";

/** Hub's models of the posts and pages the rows name (the server reads them from its database: findModelSlugOf). */
function modelOf(of: { publicationId: number | null; pageLabel: string | null }): string | null {
  if (of.publicationId === 55 || of.publicationId === 5101) return "Mia";
  return of.pageLabel?.startsWith("mia-") ? "Mia" : null;
}

/** The hand-off's address (`/api/v1/auth/sso?to=…&next=…`) on `origin`: where it leads, signed in. */
function handOff(origin: string, href: string): URL {
  const hop = new URL(href, origin);
  expect(hop.pathname, href).toBe("/api/v1/auth/sso");
  return new URL(hop.searchParams.get("next")!);
}

/** One address, followed to where it rests; the steps it took. `owner`: who opens it (a person's access is Hub's for the owner). */
function follow(start: string, owner = true): { at: string; steps: string[] } {
  let url = new URL(start);
  const steps: string[] = [];
  for (let step = 0; step < 8; step += 1) {
    const path = `${url.pathname}${url.search}`;
    if (url.origin === HUB) {
      // Hub's server: «Публикации» and «Статистика → Контент» leave for ContentOps (services/content-screens-moved.ts),
      // the owner signed in.
      const moved = contentScreenOf(path);
      if (moved !== null) {
        url = new URL(contentopsAddress(moved, modelOf({ publicationId: postOf(moved.search), pageLabel: pageOf(moved.search) }), CONTENTOPS));
        steps.push("server→contentops");
        continue;
      }
      // Hub's server: a Workboard address leaves for the team's name.
      const server = workboardOnConsoleRedirect({ here: HUB, method: "GET", url: path }, NAMES);
      if (server !== null && !server.startsWith("/api/v1/auth/sso")) {
        // An address that stays on the console's name (the old «Решения»: Hub's «Ждут вас»).
        const next = new URL(server, HUB);
        next.hash = url.hash;
        url = next;
        steps.push("server");
        continue;
      }
      if (server !== null) {
        const next = handOff(HUB, server);
        next.hash = url.hash;
        url = next;
        steps.push("server");
        continue;
      }
      // The console's old «Команда → Люди»: the registry, Hub «Люди» (App.tsx `TeamPeopleToHub`).
      const people = teamPeopleInHub(path);
      if (people !== null) {
        url = new URL(people, HUB);
        steps.push("console");
        continue;
      }
      // The console's old «Команда»: its Workboard screen, on the team's name.
      const team = teamToWorkboard(`${path}${url.hash}`, "2026-11-10");
      if (team !== null) {
        const parsed = new URL(team, HUB);
        url = new URL(handOff(HUB, workboardEntryHref(HUB, `${parsed.pathname}${parsed.search}`)));
        url.hash = parsed.hash;
        steps.push("console");
        continue;
      }
      return { at: url.href, steps };
    }
    if (NAMES.formerTeams.has(url.origin)) {
      // Hub's server on the team's former name (nginx there says Workboard moved): a Workboard page goes to the team's
      // name through the hand-off; the board's frames stay.
      const server = workboardOnFormerTeamRedirect({ here: url.origin, method: "GET", url: path, moved: true }, NAMES);
      if (server !== null) {
        const next = handOff(url.origin, server);
        next.hash = url.hash;
        url = next;
        steps.push("server");
        continue;
      }
      return { at: url.href, steps };
    }
    if (url.origin === CONTENTOPS && url.pathname === "/auth/hub/start") {
      // ContentOps' sign-in by Hub: signed in to Hub, it lands on `next`.
      url = new URL(url.searchParams.get("next")!, CONTENTOPS);
      steps.push("contentops sign-in");
      continue;
    }
    if (url.origin === TEAM && (url.pathname === BASE || url.pathname.startsWith(`${BASE}/`))) {
      const at = { pathname: url.pathname.slice(BASE.length) || "/", search: url.search, hash: url.hash };
      const moved = workboardOldAddress(at);
      if (moved !== null) {
        url = new URL(`${BASE}${moved.pathname}${moved.search}${moved.hash}`, TEAM);
        steps.push("workboard");
        continue;
      }
      // A registry tab of a person's card (screens/team/PersonRoute.tsx): Hub «Люди» for the owner, signed in on the
      // way; the person's «Команда» card for anyone else.
      const registry = registryTabLanding(at, owner);
      if (registry !== null && "hub" in registry) {
        url = new URL(handOff(TEAM, hubEntryHref(TEAM, registry.hub)));
        steps.push("workboard→hub");
        continue;
      }
      if (registry !== null) {
        url = new URL(`${BASE}${registry.workboard.pathname}${registry.workboard.search}${registry.workboard.hash}`, TEAM);
        steps.push("workboard");
        continue;
      }
    }
    return { at: url.href, steps };
  }
  throw new Error(`${start} does not come to rest`);
}

/** Whether a router path matches a route pattern (`:name` one segment, `:name?` an optional last one). */
function matchesRoute(pattern: string, path: string): boolean {
  const source = pattern.split("/").map((part) => (part.endsWith("?") ? "(?:/[^/]+)?" : part.startsWith(":") ? "/[^/]+" : part ? `/${part}` : "")).join("");
  return new RegExp(`^${source || "/"}$`).test(path === "/" ? "/" : path.replace(/\/+$/, ""));
}

/** Workboard's routes a resting address may open (apps/workboard/src/app/routes.tsx). */
const WORKBOARD_ROUTES = ["/", "/today", "/start", "/shifts", "/shifts/mine", "/shifts/team", "/team", "/team/:ref/:tab?", "/customs", "/customs/:code", "/sales/:tab", "/waiting", "/money", "/money/debts", "/money/reports", "/money/mine", "/report/:shiftId", "/account", "/fans", "/fans/subscribers", "/fans/followers", "/fans/gone", "/fans/by-spend", "/fans/by-spend/:bucketKey", "/fans/:pageLabel/:platform/:platformUserId", "/fans/:platform/:platformUserId"];

describe("old addresses", () => {
  it.each(OLD_ADDRESSES.map((row) => [row.from, row.to, row.who]))("%s lands on %s (%s)", (from, to) => {
    const { at } = follow(from);
    expect(at).toBe(to);
    const url = new URL(at);
    if (url.origin === CONTENTOPS) {
      // ContentOps' entry for Hub's addresses (apps/web/src/app/redirects.tsx HubEntryRedirect there).
      expect(["/hub/publications", "/hub/stats"], at).toContain(url.pathname);
    } else if (url.origin === TEAM) {
      const route = url.pathname.slice(BASE.length) || "/";
      expect(WORKBOARD_ROUTES.some((pattern) => matchesRoute(pattern, route)), at).toBe(true);
    } else if (NAMES.formerTeams.has(url.origin)) {
      // Only the board's frames stay on the team's former name.
      expect(url.pathname.startsWith(`${BASE}/frame/`), at).toBe(true);
    } else {
      expect(matchScreen(url.pathname)?.screen.product, at).toBe("hub");
    }
  });

  it("lands a team lead on the person's «Команда» card from an old address of the person's access", () => {
    expect(follow(`${TEAM}/workboard/people/7/access?days=7`, false).at).toBe(`${TEAM}/workboard/team/7?days=7`);
    expect(follow(`${TEAM}/workboard/access?person=7`, false).at).toBe(`${TEAM}/workboard/team/7`);
    expect(follow(`${TEAM}/workboard/people/7/access`, true).at).toBe(`${HUB}/people/7/logins`);
  });

  it("keeps the released extension's «Мои смены» on the team's name, without a sign-in hop: «Смены → Мои»", () => {
    expect(follow(`${TEAM}/workboard/my/shifts`)).toEqual({ at: `${TEAM}/workboard/shifts/mine`, steps: ["workboard"] });
  });

  it("has a router path for every old path of Workboard, and every one of them leads somewhere new", () => {
    for (const path of WORKBOARD_OLD_PATHS) {
      const sample = `/${path.replace(/:[a-zA-Z]+/g, "7")}`;
      expect(workboardOldAddress({ pathname: sample, search: "", hash: "" }), path).not.toBeNull();
    }
    for (const route of WORKBOARD_ROUTES) {
      const sample = route.replace(/:[a-zA-Z]+\??/g, "7");
      expect(workboardOldAddress({ pathname: sample, search: "", hash: "" }), route).toBeNull();
    }
  });

  it("sends a Workboard page on the team's former name on with nothing lost once nginx says it moved, and leaves everything else alone", () => {
    const [former] = [...NAMES.formerTeams];
    expect(former).toBe("https://chatgoose.gosling-agency.ru");
    const to = workboardOnFormerTeamRedirect({ here: former!, method: "GET", url: "/workboard/report/812?sale=9&from=2026-11-10", moved: true }, NAMES)!;
    const hop = new URL(to, former);
    expect(hop.pathname).toBe("/api/v1/auth/sso");
    expect(hop.searchParams.get("to")).toBe(TEAM);
    expect(hop.searchParams.get("next")).toBe(`${TEAM}/workboard/report/812?sale=9&from=2026-11-10`);
    expect(hop.searchParams.get("silent")).toBe("1");
    for (const [here, method, url, moved] of [
      [former!, "GET", "/workboard/report/812", false],
      [former!, "GET", "/workboard/frame/report", true],
      [former!, "GET", "/workboard/frame/custom?fan=1", true],
      [former!, "GET", "/workboard/assets/index-1.js", true],
      [former!, "POST", "/workboard/shifts", true],
      [former!, "GET", "/login", true],
      [former!, "GET", "/customs/", true],
      [former!, "GET", "/api/v1/auth/me", true],
      [former!, "GET", "/workboard//evil.example/x", true],
      [TEAM, "GET", "/workboard/shifts", true],
      [HUB, "GET", "/workboard/shifts", true],
    ] as const) {
      expect(workboardOnFormerTeamRedirect({ here, method, url, moved }, NAMES), `${here} ${method} ${url} ${moved}`).toBeNull();
    }
  });

  it("sends a Workboard address on the console's name on with nothing lost, and leaves everything else alone", () => {
    const to = workboardOnConsoleRedirect({ here: HUB, method: "GET", url: "/workboard/shifts/4/2026-11-06T09:16?chat=fansly%3A77" }, NAMES)!;
    expect(new URL(to, HUB).searchParams.get("next")).toBe(`${TEAM}/workboard/shifts/4/2026-11-06T09:16?chat=fansly%3A77`);
    expect(new URL(to, HUB).searchParams.get("silent")).toBe("1");
    for (const [here, method, url] of [
      [TEAM, "GET", "/workboard/shifts"],
      [HUB, "POST", "/workboard/shifts"],
      [HUB, "GET", "/workboards"],
      [HUB, "GET", "/workboard/assets/index-1.js"],
      [HUB, "GET", "/workboard/frame/report?shift=4"],
      [HUB, "GET", "/api/v1/auth/me"],
      [HUB, "GET", "/workboard//evil.example/x"],
    ] as const) {
      expect(workboardOnConsoleRedirect({ here, method, url }, NAMES), `${here} ${method} ${url}`).toBeNull();
    }
  });
});
