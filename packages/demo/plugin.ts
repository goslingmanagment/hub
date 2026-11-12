/**
 * The demo API: a Vite dev-server middleware that answers `/api/v1/*` from
 * `packages/demo/fixtures/` instead of proxying to a hub (see core.ts).
 *
 * One harness and one set of fixtures for both apps: the console
 * (`pnpm dev:demo`) and Workboard (`pnpm dev:workboard:demo`). Loaded only by
 * `vite --mode demo` (each app's vite.config.ts imports it lazily), never part
 * of a production bundle.
 */
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { kernelOperations } from "../sdk/src/operations.ts";
import { routeSchemas } from "../contracts/src/routes.ts";
import { demoError, isDemoReply, type DemoRequest, type DemoRole } from "./core.ts";

// The fixtures load through Vite's module graph on every request, so an edit
// to a fixture shows on the next reload without restarting the server. An
// absolute path: the fixtures live outside either app's Vite root.
const FIXTURES = fileURLToPath(new URL("./fixtures/index.ts", import.meta.url));

interface Route {
  key: string;
  method: string;
  pattern: RegExp;
  names: string[];
  paramCount: number;
}

const ROLE_COOKIE = "hub-demo-role";
/** A screen's other demo state (`hub-demo-scenario=healthy`): set by hand or by a screenshot tool. */
const SCENARIO_COOKIE = "hub-demo-scenario";
const ROLES: readonly DemoRole[] = ["owner", "team_lead", "chatter"];

function compile(): Route[] {
  const routes = Object.entries(kernelOperations).map(([key, def]) => {
    const names: string[] = [];
    const source = def.path
      .split("/")
      .map((segment) => {
        if (segment.startsWith(":")) {
          names.push(segment.slice(1));
          return "([^/]+)";
        }
        if (segment === "*") {
          names.push("*");
          return "(.*)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    return { key, method: def.method, pattern: new RegExp(`^${source}/?$`), names, paramCount: names.length };
  });
  // A static segment wins over a parameter: /pages/:label/followers before /pages/:label/:anything.
  return routes.sort((left, right) => left.paramCount - right.paramCount);
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    response.statusCode = 204;
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

type SchemaLike = { safeParse: (value: unknown) => { success: boolean; error?: { message: string } } };

function responseSchema(key: string, status: number): SchemaLike | undefined {
  const route = (routeSchemas as unknown as Record<string, { response?: Record<number, SchemaLike> }>)[key];
  return route?.response?.[status];
}

export interface DemoApiOptions {
  /** Where the role switch lands, by role: the app's own home. The console's by default. */
  home?: (role: DemoRole | "anon") => string;
  /**
   * Answer the console's sign-in address (`/login?next=…`) with a demo page of
   * its own: an app without the console beside it (Workboard) sends a signed-out
   * visitor there, as in production, and gets a choice of role instead of a 404.
   */
  signInPage?: boolean;
}

/** Only a path of this host: never another origin. */
function safeNext(value: string | null): string | null {
  return value !== null && value.startsWith("/") && !value.startsWith("//") ? value : null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

/** The demo's sign-in: who to be, then back to `next`. The design system's tokens by hand (no app loads here). */
function signInHtml(next: string | null): string {
  const role = (as: DemoRole) => `/__demo/role?${new URLSearchParams({ as, ...(next === null ? {} : { next }) }).toString()}`;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вход — демо</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f5f3; --surface: #ffffff; --line: #e6e3de; --text: #1c1917; --text-2: #57534e; --fill: #34467b; --fill-hover: #41558d; --hover: #f1efec; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141211; --surface: #1c1a18; --line: #2f2b28; --text: #ece8e2; --text-2: #bdb6ad; --fill: #4f66ab; --fill-hover: #5d75bd; --hover: #262321; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--text);
    font: 16px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 440px; padding: 32px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
  h1 { margin: 0 0 8px; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -0.015em; }
  p { margin: 0 0 24px; color: var(--text-2); font-size: 15px; line-height: 22px; }
  .actions { display: flex; flex-direction: column; gap: 12px; }
  a.button { display: flex; align-items: center; justify-content: center; height: 44px; border: 1px solid var(--line); border-radius: 8px;
    color: var(--text); font-size: 15px; font-weight: 500; text-decoration: none; }
  a.button:hover { background: var(--hover); }
  a.button.primary { border-color: transparent; background: var(--fill); color: #ffffff; }
  a.button.primary:hover { background: var(--fill-hover); }
  a:focus-visible { outline: 2px solid var(--fill); outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <h1>Вход в демо</h1>
  <p>Это демо на выдуманном агентстве: настоящих людей и денег здесь нет. В Hub вход общий с консолью; здесь просто выберите, кем войти${next === null ? "" : ", и вы вернётесь туда, откуда пришли"}.</p>
  <div class="actions">
    <a class="button primary" href="${escapeHtml(role("owner"))}">Войти как владелец</a>
    <a class="button" href="${escapeHtml(role("team_lead"))}">Войти как тимлид</a>
    <a class="button" href="${escapeHtml(role("chatter"))}">Войти как чаттер</a>
  </div>
</main>
</body>
</html>`;
}

/** The console's homes: /login for nobody, the cabinet for a chatter, the start otherwise. */
function consoleHome(role: DemoRole | "anon"): string {
  return role === "anon" ? "/login" : role === "chatter" ? "/account" : "/";
}

export function demoApi(options: DemoApiOptions = {}): Plugin {
  const home = options.home ?? consoleHome;
  const routes = compile();
  const warned = new Set<string>();

  return {
    name: "hub-demo-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://demo.invalid");

        // `/__demo/role`, also under an app's base (`/workboard/__demo/role`); `next` — back where the visitor was.
        if (url.pathname.endsWith("/__demo/role")) {
          const as = url.searchParams.get("as");
          // `anon`: nobody signed in, so /login and /join can be shown (`me` answers 401).
          const role = as === "anon" ? "anon" : ROLES.find((item) => item === as) ?? "owner";
          const next = role === "anon" ? null : safeNext(url.searchParams.get("next"));
          response.statusCode = 302;
          response.setHeader("set-cookie", `${ROLE_COOKIE}=${role}; Path=/; SameSite=Lax`);
          response.setHeader("location", next ?? home(role));
          response.end();
          return;
        }

        if (options.signInPage && (request.method === "GET" || request.method === "HEAD") && url.pathname === "/login") {
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.end(signInHtml(safeNext(url.searchParams.get("next"))));
          return;
        }

        if (!url.pathname.startsWith("/api/")) {
          next();
          return;
        }

        void (async () => {
          const method = (request.method ?? "GET").toUpperCase();
          const route = routes.find((item) => item.method === method && item.pattern.test(url.pathname));
          if (!route) {
            send(response, 404, { error: "not_found", message: `Демо: нет такого запроса ${method} ${url.pathname}`, statusCode: 404 });
            return;
          }
          const match = route.pattern.exec(url.pathname);
          const params: Record<string, string> = {};
          route.names.forEach((name, index) => {
            params[name] = decodeURIComponent(match?.[index + 1] ?? "");
          });
          const query: Record<string, string | string[]> = {};
          for (const [key, value] of url.searchParams.entries()) {
            const existing = query[key];
            if (existing === undefined) query[key] = value;
            else query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
          }
          const roleCookie = readCookie(request, ROLE_COOKIE);
          if (roleCookie === "anon" && route.key === "me") {
            send(response, 401, { error: "unauthorized", message: "Демо: вход не выполнен", statusCode: 401 });
            return;
          }
          const role = ROLES.find((item) => item === roleCookie) ?? "owner";
          const demoRequest: DemoRequest = {
            params, query, body: await readBody(request), now: new Date(), role, scenario: readCookie(request, SCENARIO_COOKIE),
            cookie: (name) => readCookie(request, name),
          };

          let handlers: Record<string, ((request: DemoRequest) => unknown) | undefined>;
          try {
            handlers = (await server.ssrLoadModule(FIXTURES)).demoHandlers as typeof handlers;
          } catch (error) {
            server.config.logger.error(`[demo] не загрузились данные: ${error instanceof Error ? error.message : String(error)}`);
            send(response, 500, { error: "internal", message: "Демо: не загрузились данные", statusCode: 500 });
            return;
          }
          const handler = handlers[route.key];
          if (!handler) {
            if (method !== "GET") {
              const reply = demoError(403, "forbidden", "Демо-режим: изменения не сохраняются.");
              send(response, reply.status, reply.body);
              return;
            }
            if (!warned.has(route.key)) {
              warned.add(route.key);
              server.config.logger.warn(`[demo] нет данных для ${route.key} (${method} ${url.pathname})`);
            }
            send(response, 501, { error: "not_implemented", message: `Демо: нет данных для ${route.key}`, statusCode: 501 });
            return;
          }

          let result: unknown;
          try {
            result = handler(demoRequest);
          } catch (error) {
            server.config.logger.error(`[demo] ${route.key} упал: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
            send(response, 500, { error: "internal", message: `Демо: ${route.key} упал`, statusCode: 500 });
            return;
          }
          const status = isDemoReply(result) ? result.status : 200;
          const body = isDemoReply(result) ? result.body : result;
          if (status < 300 && status !== 204) {
            const schema = responseSchema(route.key, status);
            const parsed = schema?.safeParse(body);
            if (parsed && !parsed.success) {
              server.config.logger.error(`[demo] ${route.key}: ответ не прошёл схему: ${parsed.error?.message ?? ""}`);
              send(response, 500, { error: "internal", message: `Демо: ${route.key} не прошёл схему`, statusCode: 500 });
              return;
            }
          }
          send(response, status, body);
        })();
      });
    },
  };
}
