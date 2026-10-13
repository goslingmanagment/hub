import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { beginFanslyWsConnection, type Database } from "@agency_hub_core/db";

import type { BufferEvent } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import { readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { BrowserWsSource } from "../apps/runtime/src/sync/fansly/ws/browser-source.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { SESSION_A, SESSION_B } from "./helpers/page-browser-operator.ts";
import { seedHarnessPage } from "./helpers/sync-engine.ts";

// The site's socket of a browser page (Project Browser plan §3.2 «Кадры
// сокета»; stage 3 PR 12; 0273): each connection the operator reports is a
// row of fansly_ws_connections marked `browser` with the operator's
// connection id and the page's browser credentials generation of the session
// it opened under; `ws.open` opens it once, `ws.close` closes it at the
// operator's instant, gap_since follows the previous row; the engine never
// opens a browser page's socket itself.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

interface ConnectionRow {
  origin: string;
  browserConnectionId: string | null;
  generation: string;
  startedAt: Date;
  closedAt: Date | null;
  stopReason: string | null;
  gapSince: Date;
}

async function connections(pageId: number): Promise<ConnectionRow[]> {
  const result = await testDb!.pool.query<ConnectionRow>(
    `select origin, browser_connection_id as "browserConnectionId", generation, started_at as "startedAt",
            closed_at as "closedAt", stop_reason as "stopReason", gap_since as "gapSince"
       from fansly_ws_connections where page_id = $1 order by started_at`,
    [pageId],
  );
  return result.rows;
}

function open(connectionId: string, atWall: number, sessionFingerprint = SESSION_A): BufferEvent {
  return { seq: 1, atMono: 1, atWall, kind: "ws.open", connectionId, attemptId: 1, sessionFingerprint };
}

function close(connectionId: string, atWall: number, code: number | null = 1006): BufferEvent {
  return { seq: 2, atMono: 2, atWall, kind: "ws.close", connectionId, code, reason: null };
}

describe("the site's socket of a browser page", () => {
  it("ws.open opens a browser row once; ws.close closes it at the operator's instant; the source reports it open between", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedHarnessPage({ db: db(), pool: testDb.pool }, { mode: "live", proxyUrl: "socks5://127.0.0.1:1080", label: "socket-page" });
    const source = new BrowserWsSource({ db: db(), pageId: page.pageId });
    expect(source.state).toBe("idle");
    const connectionId = randomUUID();
    const openedAt = Date.now() - 5_000;
    expect(await source.take(open(connectionId, openedAt))).toBe("opened");
    // Delivered again (the operator's stream after a reconnect): nothing twice.
    expect(await source.take(open(connectionId, openedAt))).toBe("known");
    expect(source.state).toBe("open");
    let rows = await connections(page.pageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "browser", browserConnectionId: connectionId, closedAt: null });
    expect(rows[0]!.generation).toBe(await readBrowserCredentialsGeneration(db(), page.pageId, SESSION_A));
    expect(rows[0]!.startedAt.getTime()).toBe(openedAt);

    const closedAt = Date.now() - 1_000;
    expect(await source.take(close(connectionId, closedAt))).toBe("closed");
    expect(await source.take(close(connectionId, closedAt))).toBe("known");
    expect(source.state).toBe("idle");
    rows = await connections(page.pageId);
    expect(rows[0]!.closedAt!.getTime()).toBe(closedAt);
    expect(rows[0]!.stopReason).toBe("site_closed:1006");

    // The next connection's gap starts at the previous one's close; its
    // generation follows the session it opened under.
    const next = randomUUID();
    expect(await source.take(open(next, Date.now(), SESSION_B))).toBe("opened");
    rows = await connections(page.pageId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.gapSince.getTime()).toBe(closedAt);
    expect(rows[1]!.generation).toBe(await readBrowserCredentialsGeneration(db(), page.pageId, SESSION_B));
  });

  it("a new connection closes an open row of the page as abandoned (one socket of a page at a time)", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedHarnessPage({ db: db(), pool: testDb.pool }, { mode: "live", proxyUrl: "socks5://127.0.0.1:1080", label: "socket-page-2" });
    // The engine's own socket left a row open (a crash before the switch).
    await beginFanslyWsConnection(db(), { id: randomUUID(), pageId: page.pageId, generation: "a".repeat(64) });
    const source = new BrowserWsSource({ db: db(), pageId: page.pageId });
    expect(await source.take(open(randomUUID(), Date.now()))).toBe("opened");
    const rows = await connections(page.pageId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.origin === "node")).toMatchObject({ browserConnectionId: null, stopReason: "abandoned" });
    expect(rows.find((row) => row.origin === "browser")).toMatchObject({ closedAt: null });
  });

  it("frames, gaps and site answers are the intake's (PR 13); the engine never opens the socket", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedHarnessPage({ db: db(), pool: testDb.pool }, { mode: "live", proxyUrl: "socks5://127.0.0.1:1080", label: "socket-page-3" });
    const source = new BrowserWsSource({ db: db(), pageId: page.pageId });
    expect(await source.take({ seq: 3, atMono: 3, atWall: Date.now(), kind: "ws.in", connectionId: randomUUID(), frame: "{}" })).toBe("not_a_connection_event");
    expect(await source.take({ seq: 4, atMono: 4, atWall: Date.now(), kind: "gap", fromSeq: null, fromWall: null, reason: "operator_start" })).toBe("not_a_connection_event");
    const hooks = { check: () => { throw new Error("never asked"); }, grant: () => { throw new Error("never asked"); } };
    expect(await source.handshake(hooks, new AbortController().signal)).toEqual({ kind: "aborted_before_send", refusal: "lease_inactive" });
    source.stop();
    expect(source.state).toBe("stopped");
    expect(await connections(page.pageId)).toEqual([]);
  });

  it("the database refuses a browser row without its connection id, and a node row with one", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedHarnessPage({ db: db(), pool: testDb.pool }, { mode: "live", label: "socket-page-4" });
    const insert = (origin: string, connectionId: string | null) => testDb!.pool.query(
      "insert into fansly_ws_connections (id, page_id, generation, origin, browser_connection_id) values ($1, $2, $3, $4, $5)",
      [randomUUID(), page.pageId, "b".repeat(64), origin, connectionId],
    );
    await expect(insert("browser", null)).rejects.toThrow(/fansly_ws_connections_origin_check/);
    await expect(insert("node", randomUUID())).rejects.toThrow(/fansly_ws_connections_origin_check/);
    await expect(insert("chrome", null)).rejects.toThrow(/fansly_ws_connections_origin_check/);
    const id = randomUUID();
    await insert("browser", id);
    await expect(insert("browser", id)).rejects.toThrow(/fansly_ws_connections_browser_connection/);
  });
});
