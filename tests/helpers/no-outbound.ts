import { createRequire } from "node:module";
import net from "node:net";

import type { Pool } from "pg";
import { expect } from "vitest";

/**
 * Proof that a client route is database-only: while the trap is armed nothing
 * leaves the process, no platform request is journaled, no platform work is
 * queued and no chat changes its unread count.
 *
 * Shared by every chat-extension route test (bootstrap, recaps, profile from a
 * generation, stats, awaiting reply, claim, audience-new, AI usage, the AI
 * stream with fresh text) so "the route never reaches OnlyFans" is one checked
 * property instead of a promise in each handler's comment.
 *
 * Armed, it:
 * - replaces the global `fetch` with a stub that records the call and throws;
 * - installs an undici `MockAgent` with `disableNetConnect` as the global
 *   dispatcher (undici requests that bring no dispatcher of their own);
 * - refuses every TCP/TLS connect except the test database and local unix
 *   sockets (`net.Socket#connect`), which also covers transports with their own
 *   dispatcher (egress agents, proxies);
 * - counts the rows a platform request or queued platform work leaves behind:
 *   `ofapi_request_attempts`, `ofapi_capture_jobs`, `ofapi_interactive_requests`,
 *   `ofapi_commands`, `history_requests`;
 * - snapshots `page_dm_threads.unread_count` (reading an OnlyFans chat through
 *   OFAPI marks it read on OnlyFans).
 *
 * `assertNoOutbound()` checks all of it; `restore()` undoes the trap and is safe
 * to call twice.
 */

const COUNTED_TABLES = [
  "ofapi_request_attempts",
  "ofapi_capture_jobs",
  "ofapi_interactive_requests",
  "ofapi_commands",
  "history_requests",
] as const;

// undici is not a root dependency; resolve the runtime's copy (the same pattern
// the transport tests use; a static undici import is walled off by lint).
const requireFromRuntime = createRequire(new URL("../../apps/runtime/package.json", import.meta.url));
interface UndiciDispatchOptions { origin?: unknown; path?: unknown; method?: unknown }
interface UndiciMockAgent {
  disableNetConnect(): void;
  dispatch(options: UndiciDispatchOptions, handler: unknown): boolean;
  close(): Promise<void>;
}
const undici = requireFromRuntime("undici") as {
  MockAgent: new () => UndiciMockAgent;
  getGlobalDispatcher(): unknown;
  setGlobalDispatcher(dispatcher: unknown): void;
};

export interface NoOutboundTrap {
  /** Every outbound attempt the trap refused, in order. */
  readonly attempts: readonly string[];
  /** Fails the test if anything left, was journaled, was queued or changed an unread count. */
  assertNoOutbound(): Promise<void>;
  restore(): Promise<void>;
}

interface ConnectTarget { host: string | null; port: number | null; path: string | null }

/** `socket.connect` arguments → target. Node's own callers pass a normalized `[options, cb]` array. */
function connectTarget(args: readonly unknown[]): ConnectTarget {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: unknown; port?: unknown; path?: unknown };
    return {
      host: typeof options.host === "string" ? options.host : null,
      port: options.port === undefined || options.port === null ? null : Number(options.port),
      path: typeof options.path === "string" ? options.path : null,
    };
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return { host: typeof args[1] === "string" ? args[1] : null, port: Number(first), path: null };
  }
  return { host: null, port: null, path: typeof first === "string" ? first : null };
}

function stripBrackets(host: string) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

async function countRows(pool: Pool): Promise<Record<string, number>> {
  const columns = COUNTED_TABLES.map((table) => `(select count(*)::int from ${table}) as ${table}`).join(", ");
  const { rows } = await pool.query<Record<string, number>>(`select ${columns}`);
  return rows[0]!;
}

async function unreadCounts(pool: Pool): Promise<Array<{ id: string; unread_count: number }>> {
  const { rows } = await pool.query<{ id: string; unread_count: number }>(
    "select id::text as id, unread_count from page_dm_threads order by id",
  );
  return rows;
}

export async function armNoOutboundTrap(db: { pool: Pool; connectionString: string }): Promise<NoOutboundTrap> {
  const database = new URL(db.connectionString);
  const databaseHost = stripBrackets(database.hostname);
  const databasePort = Number(database.port || 5432);
  const attempts: string[] = [];

  const rowsBefore = await countRows(db.pool);
  const unreadBefore = await unreadCounts(db.pool);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    attempts.push(`fetch ${url}`);
    return Promise.reject(new Error(`no-outbound trap: fetch to ${url} refused`));
  }) as typeof fetch;

  const originalDispatcher = undici.getGlobalDispatcher();
  const mockAgent = new undici.MockAgent();
  mockAgent.disableNetConnect();
  const mockDispatch = mockAgent.dispatch.bind(mockAgent);
  mockAgent.dispatch = (options, handler) => {
    attempts.push(`undici ${String(options.method)} ${String(options.origin)}${String(options.path)}`);
    return mockDispatch(options, handler);
  };
  undici.setGlobalDispatcher(mockAgent);

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function trappedConnect(this: net.Socket, ...args: unknown[]) {
    const target = connectTarget(args);
    // A unix socket or pipe is local IPC, not the network.
    const toDatabase = target.path !== null
      || (target.host !== null && stripBrackets(target.host) === databaseHost && target.port === databasePort);
    if (toDatabase) {
      return (originalConnect as (...connectArgs: unknown[]) => net.Socket).apply(this, args);
    }
    const where = `${target.host ?? "?"}:${target.port ?? "?"}`;
    attempts.push(`connect ${where}`);
    process.nextTick(() => this.destroy(new Error(`no-outbound trap: connection to ${where} refused`)));
    return this;
  } as typeof net.Socket.prototype.connect;

  let restored = false;
  async function restore() {
    if (restored) return;
    restored = true;
    net.Socket.prototype.connect = originalConnect;
    globalThis.fetch = originalFetch;
    undici.setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  }

  return {
    attempts,
    async assertNoOutbound() {
      expect(attempts, "outbound attempts while the trap was armed").toEqual([]);
      expect(await countRows(db.pool), "platform request journal and queued platform work").toEqual(rowsBefore);
      expect(await unreadCounts(db.pool), "page_dm_threads.unread_count").toEqual(unreadBefore);
    },
    restore,
  };
}
