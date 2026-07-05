import { describe, expect, it } from "vitest";

import { renderAuthorizationPolicyMarkdown, routeSchemas } from "@agency_hub_core/contracts";
import { createLogger } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Kernel Stage 19: the generated policy table must cover every registered route
// with its declared policy. Boots the server without a database — route
// registration is all the table needs (the same boot generate.ts performs).

async function buildTableServer() {
  const fakeDb = {
    db: {} as never,
    pool: {} as never,
    logger: createLogger("silent"),
  } as unknown as StartedTestDatabase;
  return buildApiServer(createTestAppContext(fakeDb));
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
});
