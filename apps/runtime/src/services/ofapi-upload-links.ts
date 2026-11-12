import { createHash, randomBytes, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { NotFoundError } from "./errors.ts";
import { openPublicationFile, type PublicationFileOnDisk } from "./publication-files.ts";

// A link to one file of an OnlyFans vault album (8-docs
// 2026-11-12-of-vault-album, plan PR 7, migration 0398). OnlyFansAPI takes a
// file as bytes up to 100 MB; a larger one only as `file_url`, which it
// downloads itself. Rules this file holds:
// 1. The token is 32 random bytes, handed out once (into the upload's request
//    body) and kept nowhere: the table holds its sha256, the job's stored
//    request shape holds the link's id, Hub's request log skips the route.
// 2. A link serves one file of one upload job in flight: not revoked, not
//    expired (at most 6 hours), its job without an outcome. Anything else is
//    the same 404 as an unknown token.
// 3. The upload's outcome revokes its job's links (ofapi-media-uploads.ts); a
//    newer link of the same job revokes the older (the request is built anew
//    only when the earlier one never left).

/** How long a link lives at most (plan §2.4). */
export const OFAPI_UPLOAD_LINK_TTL_MS = 6 * 60 * 60 * 1000;
/** The public route's prefix; the token follows. */
export const OFAPI_UPLOAD_LINK_PATH = "/api/v1/public/vault-upload-files/";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** How many distinct addresses a link remembers. */
const FETCHED_FROM_MAX = 20;

export function ofapiUploadLinkTokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Hub's own public origin, where OnlyFansAPI downloads from: the console's name (WEB_CONSOLE_ORIGIN). */
export function ofapiUploadLinkOrigin(config: Pick<AppContext["config"], "webConsoleOrigin">): string {
  return config.webConsoleOrigin ?? "https://hub.gosling-agency.ru";
}

/**
 * A new link for an upload job's file. Revokes the job's earlier live links
 * first (one live link a job). Returns the link's id (kept with the request)
 * and its URL (only in the request body sent to OnlyFansAPI).
 */
export async function createOfapiUploadLink(
  app: Pick<AppContext, "db" | "config">,
  input: { uploadJobId: string; pageId: number; fileId: number; now?: Date },
): Promise<{ linkId: string; url: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const linkId = randomUUID();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + OFAPI_UPLOAD_LINK_TTL_MS);
  await app.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx.execute(sql`update ofapi_upload_links set revoked_at=${now}, revoked_reason='superseded'
      where upload_job_id=${input.uploadJobId}::uuid and revoked_at is null`);
    await tx.execute(sql`insert into ofapi_upload_links (id, token_sha256, page_id, file_id, upload_job_id, created_at, expires_at)
      values (${linkId}::uuid, ${ofapiUploadLinkTokenHash(token)}, ${input.pageId}, ${input.fileId}, ${input.uploadJobId}::uuid, ${now}, ${expiresAt})`);
  });
  return { linkId, url: `${ofapiUploadLinkOrigin(app.config)}${OFAPI_UPLOAD_LINK_PATH}${token}`, expiresAt };
}

/** The upload's outcome came: its job's links serve nothing more. Returns how many were revoked. */
export async function revokeOfapiUploadLinks(db: Database, uploadJobId: string, reason: string): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`update ofapi_upload_links set revoked_at=now(), revoked_reason=${reason.slice(0, 120)}
    where upload_job_id=${uploadJobId}::uuid and revoked_at is null returning id`);
  return result.rows.length;
}

interface LinkRow extends Record<string, unknown> {
  id: string;
  file_id: string | number;
  upload_job_id: string;
  job_state: string | null;
  job_phase: string | null;
  file_sha256: string;
  job_sha256: string | null;
}

/**
 * The file a token serves now, or a 404: unknown, expired, revoked, its job
 * finished, or the job no longer names this file. `fetch`: a GET (counted,
 * with the address); a HEAD only looks.
 */
export async function resolveOfapiUploadLink(
  app: Pick<AppContext, "db" | "config">,
  token: string,
  input: { fetch: { address: string } | null; now?: Date },
): Promise<PublicationFileOnDisk> {
  const gone = () => new NotFoundError("Not found");
  if (!TOKEN.test(token)) throw gone();
  const now = input.now ?? new Date();
  const row = (await app.db.execute<LinkRow>(sql`
    select l.id, l.file_id, l.upload_job_id, j.state as job_state, j.cursor->>'phase' as job_phase,
           f.content_sha256 as file_sha256, j.target->>'sourceSha256' as job_sha256
    from ofapi_upload_links l
    join publication_files f on f.id = l.file_id
    left join ofapi_capture_jobs j on j.id = l.upload_job_id and j.page_id = l.page_id and j.kind = 'media_upload'
    where l.token_sha256 = ${ofapiUploadLinkTokenHash(token)}
      and l.revoked_at is null and l.expires_at > ${now}`)).rows[0];
  if (!row) throw gone();
  // The job's outcome came (or the job is gone): the link is over even if
  // its revocation has not been written yet.
  if (row.job_state === null || row.job_state === "complete" || row.job_state === "cancelled" || row.job_phase === "terminal") throw gone();
  // The job uploads other bytes than the link's file: never served.
  if (row.job_sha256 === null || row.job_sha256 !== row.file_sha256.trim()) throw gone();
  let onDisk: PublicationFileOnDisk;
  try {
    onDisk = await openPublicationFile(app, Number(row.file_id));
  } catch {
    throw gone();
  }
  if (input.fetch !== null) {
    const address = input.fetch.address.slice(0, 64);
    await app.db.execute(sql`update ofapi_upload_links set fetch_count = fetch_count + 1, last_fetched_at = ${now},
      fetched_from = case when ${address} = any(fetched_from) or cardinality(fetched_from) >= ${FETCHED_FROM_MAX}
        then fetched_from else array_append(fetched_from, ${address}::text) end
      where id = ${row.id}::uuid`);
  }
  return onDisk;
}

/** One `Range` of a file: `bytes=a-b`, `bytes=a-`, `bytes=-n`. Null: serve it whole; "unsatisfiable": 416. */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (header === undefined || header === "") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges, or another unit: the whole file (RFC 9110 lets a server ignore Range).
  if (!match) return null;
  const [, from, to] = match;
  if (from === "" && to === "") return null;
  if (size === 0) return "unsatisfiable";
  if (from === "") {
    const suffix = Number(to);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return "unsatisfiable";
  return { start, end };
}
