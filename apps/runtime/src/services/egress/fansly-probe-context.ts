import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { findPageByLabel, type Database } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { BadRequestError, NotFoundError, ProxyMissingError } from "../errors.ts";
import { decodeStoredFanslySession, resolveStoredProxyConfig } from "../page-context.ts";
import { resolveEgress } from "./resolver.ts";

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
) {
  const stored = await readStoredProbePage(app.db, pageLabel);
  const session = decodeStoredFanslySession(app, stored.credentials.encryptedSession, pageLabel);
  if (typeof session?.authorization !== "string" || session.authorization.trim().length === 0) {
    throw new BadRequestError(`Page "${pageLabel}" has no nonempty stored Fansly token`);
  }
  // Validate before obtaining a dispatcher; this path never opens an incident.
  resolveStoredProxyConfig(app, stored.proxy);
  const generation = probeGeneration(stored);
  const egress = await resolveEgress(app, { kind: "page", pageId: stored.page.id });
  // Secret-bearing context stays inside the operator process. Only explicitly
  // selected identity fields and the generation may enter a diagnostic receipt.
  return {
    token: session.authorization, session, pageId: stored.page.id,
    expectedAccountId: stored.page.platformAccountId, generation, egress,
  };
}

async function readStoredProbePage(db: Database, pageLabel: string) {
  const stored = await findPageByLabel(db, pageLabel);
  // Catalog lookup excludes deleted pages.
  if (!stored) throw new NotFoundError(`Page "${pageLabel}" not found`);
  if (stored.page.platform !== "fansly") {
    throw new BadRequestError(`Page "${pageLabel}" is not a Fansly page`);
  }
  if (!stored.credentials) {
    throw new BadRequestError(`Page "${pageLabel}" has no stored platform credentials`);
  }
  if (!stored.proxy) {
    throw new ProxyMissingError(`Page "${pageLabel}" has no assigned proxy; Fansly probe refused`);
  }
  return { page: stored.page, credentials: stored.credentials, proxy: stored.proxy };
}

function probeGeneration(stored: Awaited<ReturnType<typeof readStoredProbePage>>) {
  return createHash("sha256").update(JSON.stringify({
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
}

/** B0 calls this inside its row-locked capture transaction. No decryption or
 * dispatcher allocation, with the identical digest used by W0 receipts. */
export async function readFanslyPageGeneration(db: Database, pageLabel: string) {
  return probeGeneration(await readStoredProbePage(db, pageLabel));
}

export async function readProbeSnapshot(
  db: Database,
  config: AppContext["config"],
  pageLabel: string,
) {
  return withProbeSnapshot(db, (snapshot) => resolveFanslyProbeContext({ db: snapshot, config }, pageLabel));
}

/** Periodic observation must not decrypt another token or allocate dispatchers. */
export function readProbeGeneration(db: Database, pageLabel: string) {
  return withProbeSnapshot(db, async (snapshot) => probeGeneration(await readStoredProbePage(snapshot, pageLabel)));
}

function withProbeSnapshot<T>(db: Database, read: (snapshot: Database) => Promise<T>) {
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`select
      current_setting('transaction_read_only') as read_only,
      current_setting('transaction_isolation') as isolation`);
    const identity = result.rows[0];
    if (identity?.read_only !== "on" || identity.isolation !== "repeatable read") {
      throw new Error("probe_read_only_snapshot_required");
    }
    return read(tx as unknown as Database);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
