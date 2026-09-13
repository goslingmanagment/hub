import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { findPageByLabel, type Database } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { BadRequestError, NotFoundError, ProxyMissingError } from "../errors.ts";
import { decodeStoredFanslySession, resolveStoredProxyConfig } from "../page-context.ts";
import { resolveEgress, type AppEgressContext } from "./resolver.ts";

/**
 * The caller must pass its READ ONLY, REPEATABLE READ transaction as app.db.
 * Both this lookup and resolveEgress's lookup then see the same credential and
 * proxy generation, even if another session changes the page between reads.
 * Close the owned egress after the bounded probe; never call pace() here.
 * Loading credentials proves neither Management Session scope nor account binding.
 */
export async function resolveFanslyProbeContext(
  app: Pick<AppContext, "db" | "config">,
  pageLabel: string,
): Promise<{ token: string; pageId: number; generation: string; egress: AppEgressContext }> {
  const stored = await findPageByLabel(app.db, pageLabel);
  // Catalog lookup excludes deleted pages.
  if (!stored) throw new NotFoundError(`Page "${pageLabel}" not found`);
  if (stored.page.platform !== "fansly") {
    throw new BadRequestError(`Page "${pageLabel}" is not a Fansly page`);
  }
  if (!stored.credentials) {
    throw new BadRequestError(`Page "${pageLabel}" has no stored platform credentials`);
  }
  const session = decodeStoredFanslySession(app, stored.credentials.encryptedSession, pageLabel);
  if (typeof session?.authorization !== "string" || session.authorization.trim().length === 0) {
    throw new BadRequestError(`Page "${pageLabel}" has no nonempty stored Fansly token`);
  }
  if (!stored.proxy) {
    throw new ProxyMissingError(`Page "${pageLabel}" has no assigned proxy; Fansly probe refused`);
  }
  // Validate before obtaining a dispatcher; unlike resolvePageContext this path
  // never opens an incident. The caller reports a fixed, sanitized error code.
  resolveStoredProxyConfig(app, stored.proxy);
  const generation = createHash("sha256").update(JSON.stringify({
    pageId: stored.page.id,
    platform: stored.page.platform,
    nativeAccountId: stored.page.platformAccountId,
    credentials: {
      ciphertext: stored.credentials.encryptedSession,
      keyVersion: stored.credentials.keyVersion,
    },
    proxy: {
      id: stored.proxy.id,
      url: stored.proxy.url,
      ciphertext: stored.proxy.encryptedAuth,
      keyVersion: stored.proxy.keyVersion,
      rateLimitScopeKey: stored.proxy.rateLimitScopeKey,
    },
  })).digest("hex");
  const egress = await resolveEgress(app, { kind: "page", pageId: stored.page.id });
  return { token: session.authorization, pageId: stored.page.id, generation, egress };
}

export async function readProbeSnapshot(
  db: Database,
  config: AppContext["config"],
  pageLabel: string,
) {
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`select
      current_setting('transaction_read_only') as read_only,
      current_setting('transaction_isolation') as isolation`);
    const identity = result.rows[0];
    if (identity?.read_only !== "on" || identity.isolation !== "repeatable read") {
      throw new Error("probe_read_only_snapshot_required");
    }
    return resolveFanslyProbeContext({ config, db: tx as unknown as Database }, pageLabel);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
