/**
 * The demo API: a Vite dev-server middleware that answers `/api/v1/*` from
 * `demo/fixtures/` instead of proxying to a hub (see demo/core.ts).
 *
 * Loaded only by `vite --mode demo` (vite.config.ts imports it lazily), never
 * part of the production bundle.
 */
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { kernelOperations } from "../../../packages/sdk/src/operations.ts";
import { routeSchemas } from "../../../packages/contracts/src/routes.ts";
import { demoError, isDemoReply, type DemoRequest, type DemoRole } from "./core.ts";

// The fixtures load through Vite's module graph on every request, so an edit
// to a fixture shows on the next reload without restarting the server.
const FIXTURES = "/demo/fixtures/index.ts";

interface Route {
  key: string;
  method: string;
  pattern: RegExp;
  names: string[];
  paramCount: number;
}

const ROLE_COOKIE = "hub-demo-role";
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

export function demoApi(): Plugin {
  const routes = compile();
  const warned = new Set<string>();

  return {
    name: "hub-demo-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://demo.invalid");

        if (url.pathname === "/__demo/role") {
          const as = url.searchParams.get("as");
          // `anon`: nobody signed in, so /login and /join can be shown (`me` answers 401).
          const role = as === "anon" ? "anon" : ROLES.find((item) => item === as) ?? "owner";
          response.statusCode = 302;
          response.setHeader("set-cookie", `${ROLE_COOKIE}=${role}; Path=/; SameSite=Lax`);
          response.setHeader("location", role === "anon" ? "/login" : role === "chatter" ? "/account" : "/");
          response.end();
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
          const demoRequest: DemoRequest = { params, query, body: await readBody(request), now: new Date(), role };

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
