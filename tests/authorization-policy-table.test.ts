import { describe, expect, it } from "vitest";

import { renderAuthorizationPolicyMarkdown, routeSchemas } from "@agency_hub_core/contracts";
import { createLogger } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Kernel Stage 19: the generated policy table must cover every registered route
// with its declared policy. Boots the server without a database — route
// registration is all the table needs (the same boot generate.ts performs).

async function buildTableServer(authPolicyEnforcement: "log" | "enforce" = "log") {
  const fakeDb = {
    db: {} as never,
    pool: {} as never,
    logger: createLogger("silent"),
  } as unknown as StartedTestDatabase;
  return buildApiServer(createTestAppContext(fakeDb, { authPolicyEnforcement }));
}

describe("authorization policy table", () => {
  it("covers every routeSchemas key exactly once, all declared", async () => {
    const server = await buildTableServer();
    try {
      const table = server.routePolicyTable;
      expect(table).toHaveLength(Object.keys(routeSchemas).length);

      const keys = table.map((row) => row.routeKey).sort();
      expect(keys).toEqual(Object.keys(routeSchemas).sort());
      expect(new Set(keys).size).toBe(keys.length);

      expect(table.filter((row) => row.auth === null)).toEqual([]);
      expect(table.filter((row) => row.method === "HEAD")).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("renders a deterministic markdown table with the declared policies", async () => {
    const server = await buildTableServer();
    try {
      const first = renderAuthorizationPolicyMarkdown(server.routePolicyTable);
      const second = renderAuthorizationPolicyMarkdown([...server.routePolicyTable].reverse());
      expect(second).toBe(first);

      expect(first).toContain("# Authorization policy");
      expect(first).toContain(`## Routes (${server.routePolicyTable.length})`);
      expect(first).not.toContain("UNDECLARED");
      expect(first).toContain(
        "| GET | `/api/v1/admin/users` | `adminListUsers` | `owner-session` | — | — |",
      );
      expect(first).toContain(
        "| POST | `/api/v1/ofapi/webhook` | `ofapiWebhookReceive` | `hmac` | — | — |",
      );
      expect(first).toContain(
        "| GET | `/api/v1/pages/:pageLabel/revenue` | `pageRevenue` | `session` | — | page |",
      );
      expect(first).toContain(
        "| GET | `/api/v1/pages/:pageLabel/subscribers` | `pageSubscribers` | `any` | — | page |",
      );
    } finally {
      await server.close();
    }
  });

  it("rejects additional API routes without a registered schema, even with a forged binding", async () => {
    const server = await buildTableServer();
    try {
      expect(() => server.get("/api/v1/unregistered", async () => ({})))
        .toThrow("must use a registered contract schema");
      expect(() => server.get("/api/v1/cloned", {
        schema: { ...routeSchemas.adminListUsers },
        config: { hubAuthPolicy: { key: "health", auth: { kind: "public" } } },
      }, async (_request, reply) => {
        reply.raw.statusCode = 204;
        reply.raw.end();
        return reply;
      }))
        .toThrow("must use a registered contract schema");
      // Existing known-route coverage is unchanged: rejecting the extra route
      // does not depend on a missing or duplicate contract key in the census.
      expect(server.routePolicyTable).toHaveLength(Object.keys(routeSchemas).length);
    } finally {
      await server.close();
    }
  });

  it("validates page scope against the registered path", async () => {
    const server = await buildTableServer();
    try {
      expect(() => server.get("/api/v1/missing-page-param", {
        schema: routeSchemas.pageRevenue,
      }, async (_request, reply) => {
        reply.raw.statusCode = 204;
        reply.raw.end();
        return reply;
      }))
        .toThrow("must declare :pageLabel");
    } finally {
      await server.close();
    }
  });

  it("preserves route config and protects both GET and its automatic HEAD twin", async () => {
    const server = await buildTableServer("enforce");
    try {
      server.get("/api/v1/bound-owner", {
        schema: routeSchemas.adminListUsers,
        config: { rateLimit: { max: 7, timeWindow: "1 minute" } },
      }, async (_request, reply) => {
        reply.raw.statusCode = 204;
        reply.raw.end();
        return reply;
      });
      server.get("/api/v1/bound-public", {
        schema: routeSchemas.health,
        config: { rateLimit: { max: 7, timeWindow: "1 minute" } },
      }, async (request, reply) => {
        expect(request.routeOptions.config.rateLimit).toEqual({ max: 7, timeWindow: "1 minute" });
        reply.raw.statusCode = 204;
        reply.raw.end();
        return reply;
      });
      let hmacHandlerCalled = false;
      server.post("/api/v1/bound-hmac", { schema: routeSchemas.ofapiWebhookReceive },
        async (_request, reply) => {
          // HMAC authentication belongs to the handler, not principal lookup.
          hmacHandlerCalled = true;
          reply.raw.statusCode = 204;
          reply.raw.end();
          return reply;
        });
      for (const method of ["GET", "HEAD"] as const) {
        expect((await server.inject({ method, url: "/api/v1/bound-owner" })).statusCode).toBe(401);
        expect((await server.inject({ method, url: "/api/v1/bound-public" })).statusCode).toBe(204);
      }
      expect(server.routePolicyTable.filter(row => row.url === "/api/v1/bound-owner"))
        .toHaveLength(1);
      expect((await server.inject({ method: "POST", url: "/api/v1/bound-hmac", payload: {} })).statusCode)
        .toBe(204);
      expect(hmacHandlerCalled).toBe(true);
      expect((await server.inject("/api/v1/does-not-exist")).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it.each(["log", "enforce"] as const)("handles a lost request binding in %s mode", async (mode) => {
    const server = await buildTableServer(mode);
    try {
      // Simulate a later plugin accidentally overwriting the bound config.
      server.addHook("onRoute", route => {
        if (route.url === "/api/v1/lost-binding") {
          delete route.config?.hubAuthPolicy;
        }
      });
      server.get("/api/v1/lost-binding", { schema: routeSchemas.health },
        async (_request, reply) => {
          reply.raw.statusCode = 204;
          reply.raw.end();
          return reply;
        });
      const response = await server.inject("/api/v1/lost-binding");
      expect(response.statusCode).toBe(mode === "enforce" ? 403 : 204);
      if (mode === "enforce") {
        expect(response.json().message).toBe("Route has no authorization binding");
      }
      expect((await server.inject("/api/v1/does-not-exist")).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
