import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { NARROW_WEB_SESSION_OPERATIONS, NARROW_WEB_SESSION_PASSWORD_ONLY } from "../packages/contracts/src/web-session-scopes.ts";
import { NAME_MENU_ACCOUNT, WORKBOARD_PATH, teamMenu } from "../packages/ui/src/screens.ts";

// The narrow web session (opened from the extension, no password) and the chatter's part of Workboard: every screen
// a chatter can open from Workboard's frame — its menu (the one table, packages/ui/src/screens.ts) and its name menu —
// and every deep page under one, calls only operations the narrow session may call, or ones that need the password
// (NARROW_WEB_SESSION_PASSWORD_ONLY) on a screen that shows the way to it instead (PasswordWayIn). A new chatter
// screen, or a new call on one, fails here until it is put on one of the two lists. The code is read, not run: the
// imports of each screen's modules inside apps/workboard/src are followed and every `kernel.<operation>` collected.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "apps/workboard/src");
const ROUTES = resolve(SRC, "app/routes.tsx");
const PASSWORD_WAY_IN = resolve(SRC, "shared/PasswordWayIn.tsx");

const narrow = new Set<string>(NARROW_WEB_SESSION_OPERATIONS);
const passwordOnly = new Set<string>(NARROW_WEB_SESSION_PASSWORD_ONLY);

/** A Workboard module an import names, or null for a package's. */
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = resolve(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  base = base.replace(/\.js$/, "");
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every Workboard module the entries reach, and the operations they call through `kernel`. */
function reach(entries: readonly string[]): { modules: Set<string>; operations: Map<string, Set<string>> } {
  const modules = new Set<string>();
  const operations = new Map<string, Set<string>>();
  const walk = (file: string) => {
    if (modules.has(file)) return;
    modules.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bkernel\.([A-Za-z0-9]+)\b/g)) {
      const where = operations.get(match[1]!) ?? new Set<string>();
      where.add(relative(SRC, file));
      operations.set(match[1]!, where);
    }
    for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
      const next = resolveImport(file, match[1]!);
      if (next) walk(next);
    }
  };
  for (const entry of entries) walk(entry);
  return { modules, operations };
}

/** The routes a chatter's session opens (routes.tsx `chatterScreens` and `everyoneScreens`): path and screen module. */
function chatterRoutes(): Array<{ path: string; module: string | null }> {
  const text = readFileSync(ROUTES, "utf8");
  const arrays = ["chatterScreens", "everyoneScreens"].map((name) => {
    const start = text.indexOf(`const ${name}: RouteObject[] = [`);
    expect(start, `routes.tsx has ${name}`).toBeGreaterThanOrEqual(0);
    return text.slice(start, text.indexOf("\n];", start));
  });
  return arrays.flatMap((array) => array.split(/\{\s*\n?\s*path: /).slice(1).map((chunk) => {
    const path = /^"([^"]+)"/.exec(chunk)?.[1];
    expect(path, `a route path in ${chunk.slice(0, 60)}`).toBeDefined();
    const module = /import\("(\.\.\/screens\/[^"]+)"\)/.exec(chunk)?.[1];
    return { path: path!, module: module ? resolveImport(ROUTES, module) : null };
  }));
}

/** The chatter's screens of Workboard's frame: its menu (a newcomer's, the longest) and the name menu. */
function chatterScreens(): Array<{ id: string; path: string }> {
  const menu = teamMenu("chatter", { newcomer: true }).map((item) => ({ id: item.id, path: item.to }));
  return [...menu, { id: NAME_MENU_ACCOUNT.id, path: NAME_MENU_ACCOUNT.path }];
}

/** Whether a route (`customs/:code`) is the screen's address or under it (`/workboard/customs`). */
function under(screenPath: string, routePath: string): boolean {
  const screen = screenPath.slice(WORKBOARD_PATH.length).split("/");
  const route = routePath.split("/");
  return screen.every((segment, index) => route[index] === segment);
}

describe("the narrow web session and the chatter's screens", () => {
  it("never lets a session without a password do what needs one", () => {
    expect([...passwordOnly].filter((operation) => narrow.has(operation))).toEqual([]);
  });

  it("knows the chatter's menu and name menu: «Начало», «Мои смены», «Кастомы», «Аккаунт и устройства»", () => {
    expect(chatterScreens().map((screen) => screen.path).sort()).toEqual([
      "/workboard/account", "/workboard/customs", "/workboard/my/shifts", "/workboard/start",
    ]);
  });

  it("every page a chatter's session opens is under a screen of those menus", () => {
    const screens = chatterScreens();
    const orphans = chatterRoutes().filter((route) => route.module !== null && !screens.some((screen) => under(screen.path, route.path)));
    expect(orphans.map((route) => route.path)).toEqual([]);
  });

  const routes = chatterRoutes();
  it.each(chatterScreens().map((screen) => [screen.id, screen] as const))("%s calls only what a narrow session may, or shows the way to the password", (_id, screen) => {
    const modules = routes.filter((route) => route.module !== null && under(screen.path, route.path)).map((route) => route.module!);
    expect(modules.length, `${screen.path} has its screen's module in routes.tsx`).toBeGreaterThan(0);
    const { modules: reached, operations } = reach(modules);
    const refused = [...operations].filter(([operation]) => !narrow.has(operation) && !passwordOnly.has(operation))
      .map(([operation, files]) => `${operation} (${[...files].join(", ")})`);
    expect(refused, `${screen.path}: put each on NARROW_WEB_SESSION_OPERATIONS, or on NARROW_WEB_SESSION_PASSWORD_ONLY with PasswordWayIn on the screen`).toEqual([]);
    const needsPassword = [...operations.keys()].filter((operation) => passwordOnly.has(operation));
    if (needsPassword.length > 0) {
      expect(reached.has(PASSWORD_WAY_IN), `${screen.path} calls ${needsPassword.join(", ")}: it must show PasswordWayIn to a narrow session`).toBe(true);
    }
  });
});
