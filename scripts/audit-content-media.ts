// Counts and body readability only; never prints captions, filenames, or URLs.
// CONTENT_MEDIA_DATABASE_URL must authenticate as the dedicated read_only role.
import { createDb, createPool, listObservationsForReplay } from "@agency_hub_core/db";
import { createLogger } from "@agency_hub_core/shared";
import { resolveCapturePayloadRow } from "../apps/runtime/src/services/payload-reader.ts";
import { canParsePostsObservation } from "../apps/runtime/src/services/canonicalize/posts.ts";
import { canParseFanslyCatalogObservation } from "../apps/runtime/src/services/canonicalize/fansly-catalog.ts";
import { fanslyRawMediaDrafts, onlyFansRawMediaDrafts } from "../apps/runtime/src/services/canonicalize/raw-media.ts";
import { capturePayloadResponse, parseOfapiJsonBytes, parseStrictOfapiPostPage } from "../apps/runtime/src/services/ofapi-capture-contract.ts";

const input = process.env.CONTENT_MEDIA_DATABASE_URL;
if (!input) throw new Error("Set CONTENT_MEDIA_DATABASE_URL for the dedicated read_only role");
const url = new URL(input);
if (decodeURIComponent(url.username) !== "read_only") throw new Error("Only the read_only database role is permitted");
url.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=30000");
url.searchParams.set("application_name", "content_media_archive_audit");
const pool = createPool(url.toString());
const db = createDb(pool);
const all = process.argv.includes("--all-bodies");
try {
  const identity = await pool.query("select current_user, current_setting('transaction_read_only') as readonly");
  if (identity.rows[0]?.current_user !== "read_only" || identity.rows[0]?.readonly !== "on") throw new Error("Read-only session required");
  const census = await pool.query(`
    select o.account_id::text as page_id, p.label as page_label,
           to_char(date_trunc('month', o.received_at), 'YYYY-MM-DD') as month,
           o.kind, count(*)::text as observations,
           count(*) filter (where o.payload is not null)::text as inline_bodies,
           count(*) filter (where o.payload_object_id is not null)::text as catalog_refs,
           min(o.parse_version) as min_parse_version, max(o.parse_version) as max_parse_version
      from observations o left join pages p on p.id = o.account_id
     where o.kind in ('vault_albums', 'uservault_albums', 'vault_media', 'posts', 'ofapi.posts_page.v1')
       and o.account_id is not null
     group by o.account_id, p.label, date_trunc('month', o.received_at), o.kind
     order by o.account_id, month, o.kind
  `);
  const logger = createLogger("silent");
  const report = [];
  for (const group of census.rows) {
    const from = new Date(`${group.month}T00:00:00Z`);
    const to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1);
    let afterId: number | null = null;
    let sampled = 0; let readable = 0; let unreadable = 0;
    const fields = { shapeRejected: 0, fileRecords: 0, filenames: 0, durations: 0, originalDimensions: 0, frameRates: 0 };
    do {
      const rows = await listObservationsForReplay(db, { accountId: Number(group.page_id), kinds: [group.kind],
        belowParseVersion: 2147483647, from, to, afterId, limit: all ? 100 : 3 });
      for (const row of rows) {
        sampled += 1;
        try {
          const resolved = await resolveCapturePayloadRow({ db, logger }, "observation", row.id, row);
          if (resolved.payload === null) { unreadable += 1; continue; }
          readable += 1;
          let drafts;
          if (row.kind === "ofapi.posts_page.v1") {
            const response = capturePayloadResponse(resolved.payload);
            const body = response ? parseOfapiJsonBytes(response.bodyBytes) : null;
            const page = body?.validJson ? parseStrictOfapiPostPage(body.body, { requiredOverlapId: null, stopAtPostId: null }) : null;
            if (!response || response.status < 200 || response.status >= 300 || !page?.accepted) { fields.shapeRejected += 1; continue; }
            drafts = onlyFansRawMediaDrafts(resolved, page.items.flatMap(item => Array.isArray(item.media) ? item.media : []));
          } else {
            const parseable = row.kind === "posts" ? canParsePostsObservation(resolved) : canParseFanslyCatalogObservation(resolved);
            if (!parseable) fields.shapeRejected += 1;
            drafts = fanslyRawMediaDrafts(resolved);
          }
          for (const { data } of drafts) {
            fields.fileRecords += 1;
            if (data.filename !== null) fields.filenames += 1;
            if (data.durationMs !== null) fields.durations += 1;
            if (data.originalWidth !== null && data.originalHeight !== null) fields.originalDimensions += 1;
            if (data.frameRateMilli !== null) fields.frameRates += 1;
          }
        } catch { unreadable += 1; }
      }
      afterId = rows.at(-1)?.id ?? null;
      if (!all || rows.length < 100) break;
    } while (afterId !== null);
    report.push({ ...group, sampled, readable, unreadable, ...fields, allBodiesChecked: sampled === Number(group.observations) });
  }
  process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), mode: all ? "all_bodies" : "sample_3_per_group", monthly: report }, null, 2)}\n`);
  if (report.some(row => row.unreadable > 0)) process.exitCode = 1;
} finally { await pool.end(); }
