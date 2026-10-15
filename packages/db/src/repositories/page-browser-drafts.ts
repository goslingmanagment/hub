import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Project Browser (plan §3.2 «Подключение новой страницы через браузер»;
// 0282; owner decision 2026-10-15): a page's server browser starts in the
// dashboard as a draft — its name (the page's label, the container's name),
// a new page's proxy as the owner pasted it (its login and password sealed by
// the caller, as `egress_endpoints.encrypted_auth`), or the existing page
// that moves to its browser (its proxy is its own), and the environment the
// owner confirmed. `scripts/deploy-page-browser.sh add-profile` reads it
// (`sync browser-profile draft`), makes the container from it, and the
// profile's registration takes it under its row lock and consumes it in the
// same transaction (`sync browser-profile add --from-draft`): only the
// revision add-profile read.

export interface PageBrowserDraft {
  name: string;
  /** An existing page that moves to its browser (null: a new page). */
  pageId: number | null;
  /** That page's label (null: a new page). */
  pageLabel: string | null;
  /** A new page's proxy (its auth sealed); null for an existing page's. */
  proxy: { url: string; encryptedAuth: string | null; keyVersion: number | null } | null;
  env: Record<string, unknown>;
  revision: number;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export const PAGE_BROWSER_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export class PageBrowserDraftError extends Error {
  constructor(
    readonly reason: "bad_name" | "name_is_a_page" | "name_has_browser" | "no_page" | "page_has_browser" | "label_mismatch" | "no_proxy" | "not_socks5",
    message: string,
  ) {
    super(message);
    this.name = "PageBrowserDraftError";
  }
}

type DraftRow = {
  name: string;
  pageId: string | null;
  pageLabel: string | null;
  proxyUrl: string | null;
  proxyAuth: string | null;
  proxyKeyVersion: number | null;
  env: unknown;
  revision: string;
  createdAt: Date | string;
  createdBy: string;
  updatedAt: Date | string;
  updatedBy: string;
};

const columns = sql`
  d.name,
  d.page_id::text as "pageId",
  p.label as "pageLabel",
  d.proxy_url as "proxyUrl",
  d.proxy_auth as "proxyAuth",
  d.proxy_key_version as "proxyKeyVersion",
  d.env,
  d.revision::text as revision,
  d.created_at as "createdAt",
  d.created_by as "createdBy",
  d.updated_at as "updatedAt",
  d.updated_by as "updatedBy"
`;

const dateOf = (value: Date | string) => (value instanceof Date ? value : new Date(value));

function draftOf(row: DraftRow): PageBrowserDraft {
  return {
    name: row.name,
    pageId: row.pageId === null ? null : Number(row.pageId),
    pageLabel: row.pageLabel,
    proxy: row.proxyUrl === null ? null : { url: row.proxyUrl, encryptedAuth: row.proxyAuth, keyVersion: row.proxyKeyVersion },
    env: row.env !== null && typeof row.env === "object" && !Array.isArray(row.env) ? (row.env as Record<string, unknown>) : {},
    revision: Number(row.revision),
    createdAt: dateOf(row.createdAt),
    createdBy: row.createdBy,
    updatedAt: dateOf(row.updatedAt),
    updatedBy: row.updatedBy,
  };
}

/** Every draft, the oldest first. */
export async function listPageBrowserDrafts(db: Database): Promise<PageBrowserDraft[]> {
  const result = await db.execute<DraftRow>(sql`
    select ${columns} from page_browser_drafts d left join pages p on p.id = d.page_id order by d.created_at, d.name
  `);
  return result.rows.map(draftOf);
}

export async function findPageBrowserDraft(db: Database, name: string): Promise<PageBrowserDraft | null> {
  if (!PAGE_BROWSER_NAME.test(name)) return null;
  const result = await db.execute<DraftRow>(sql`
    select ${columns} from page_browser_drafts d left join pages p on p.id = d.page_id where d.name = ${name}
  `);
  const row = result.rows[0];
  return row === undefined ? null : draftOf(row);
}

/** A draft locked until the caller's transaction ends (the registration). */
export async function lockPageBrowserDraft(tx: Database, name: string): Promise<PageBrowserDraft | null> {
  if (!PAGE_BROWSER_NAME.test(name)) return null;
  const result = await tx.execute<DraftRow>(sql`
    select ${columns} from page_browser_drafts d left join pages p on p.id = d.page_id where d.name = ${name} for update of d
  `);
  const row = result.rows[0];
  return row === undefined ? null : draftOf(row);
}

/** A registration took the draft: removed, only at the revision it read.
 *  True: removed. */
export async function consumePageBrowserDraft(tx: Database, input: { name: string; revision: number }): Promise<boolean> {
  const result = await tx.execute(sql`
    delete from page_browser_drafts where name = ${input.name} and revision = ${input.revision}::bigint returning name
  `);
  return result.rows.length === 1;
}

/** The owner's delete of a draft. True: there was one. */
export async function deletePageBrowserDraft(db: Database, name: string): Promise<boolean> {
  if (!PAGE_BROWSER_NAME.test(name)) return false;
  const result = await db.execute(sql`delete from page_browser_drafts where name = ${name} returning name`);
  return result.rows.length === 1;
}

/**
 * Why `name` cannot be a browser to be made now — a new page's (no page of
 * that label, no profile's container of that name) or the existing page
 * `pageId`'s (an active Fansly page of that label with no browser yet) — or
 * null. Read in the caller's transaction (the save, the registration).
 */
export async function pageBrowserDraftProblem(tx: Database, input: { name: string; pageId: number | null }): Promise<PageBrowserDraftError | null> {
  if (!PAGE_BROWSER_NAME.test(input.name)) {
    return new PageBrowserDraftError("bad_name", `"${input.name}" is not a browser's name: lowercase letters, digits and dashes, up to 41`);
  }
  const found = await tx.execute<{ labelPage: boolean; container: boolean; page: { id: string; label: string } | null; pageHasBrowser: boolean }>(sql`
    select exists (select 1 from pages where label = ${input.name}) as "labelPage",
           exists (select 1 from page_browsers where container = ${`page-browser-${input.name}`}) as container,
           (select json_build_object('id', id::text, 'label', label) from pages
             where id = ${input.pageId}::bigint and platform = 'fansly' and status = 'active') as page,
           exists (select 1 from page_browsers where ${input.pageId}::bigint is not null and page_id = ${input.pageId}::bigint) as "pageHasBrowser"
  `);
  const row = found.rows[0]!;
  if (row.container) return new PageBrowserDraftError("name_has_browser", `A browser named ${input.name} exists already (page-browser-${input.name})`);
  if (input.pageId === null) {
    if (row.labelPage) return new PageBrowserDraftError("name_is_a_page", `A page ${input.name} exists: it moves to its browser as an existing page`);
    return null;
  }
  const page = row.page;
  if (page === null) return new PageBrowserDraftError("no_page", `No active Fansly page ${input.pageId}`);
  if (page.label !== input.name) return new PageBrowserDraftError("label_mismatch", `An existing page's browser is named by its label: ${page.label}`);
  if (row.pageHasBrowser) return new PageBrowserDraftError("page_has_browser", `Page ${page.label} has a browser already`);
  return null;
}

export interface SavePageBrowserDraftInput {
  name: string;
  pageId: number | null;
  /** A new page's proxy, sealed by the caller (`socks5://host:port`).
   *  Undefined: the stored one is kept (an edit that leaves it). */
  proxy?: { url: string; encryptedAuth: string; keyVersion: number };
  env: Record<string, unknown>;
  by: string;
}

/**
 * The owner's draft, created or saved again (its revision raised), in one
 * transaction under the draft's row: refused — nothing written — for a name
 * that cannot be a browser to be made now, and for a new page's draft with
 * no proxy.
 */
export async function savePageBrowserDraft(db: Database, input: SavePageBrowserDraftInput): Promise<PageBrowserDraft> {
  if (input.proxy !== undefined && !input.proxy.url.startsWith("socks5://")) {
    throw new PageBrowserDraftError("not_socks5", "A page's browser goes out through a SOCKS5 proxy only");
  }
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`page_browser_draft:${input.name}`}, 0))`);
    const problem = await pageBrowserDraftProblem(tx, { name: input.name, pageId: input.pageId });
    if (problem !== null) throw problem;
    const current = await lockPageBrowserDraft(tx, input.name);
    const proxy = input.pageId !== null
      ? null
      : input.proxy ?? (current !== null && current.pageId === null ? current.proxy : null);
    if (input.pageId === null && proxy === null) throw new PageBrowserDraftError("no_proxy", "A new page's browser needs its proxy");
    const env = JSON.stringify(input.env);
    await tx.execute(sql`
      insert into page_browser_drafts (name, page_id, proxy_url, proxy_auth, proxy_key_version, env, created_by, updated_by)
      values (${input.name}, ${input.pageId}::bigint, ${proxy?.url ?? null}, ${proxy?.encryptedAuth ?? null}, ${proxy?.keyVersion ?? null}::integer,
              ${env}::jsonb, ${input.by}, ${input.by})
      on conflict (name) do update
         set page_id = excluded.page_id,
             proxy_url = excluded.proxy_url,
             proxy_auth = excluded.proxy_auth,
             proxy_key_version = excluded.proxy_key_version,
             env = excluded.env,
             revision = page_browser_drafts.revision + 1,
             updated_at = clock_timestamp(),
             updated_by = excluded.updated_by
    `);
    return (await lockPageBrowserDraft(tx, input.name))!;
  });
}

/** An active Fansly page by its label — its id and its own proxy as stored
 *  (its auth sealed) — or null. */
export async function findFanslyPageForBrowser(db: Database, label: string): Promise<{ pageId: number; label: string; proxy: { url: string; encryptedAuth: string | null } | null } | null> {
  const result = await db.execute<{ pageId: string; label: string; url: string | null; auth: string | null }>(sql`
    select p.id::text as "pageId", p.label, e.url, e.encrypted_auth as auth
      from pages p
      left join egress_endpoints e on e.platform_account_id = p.id
     where p.label = ${label} and p.platform = 'fansly' and p.status = 'active'
  `);
  const row = result.rows[0];
  return row === undefined ? null : { pageId: Number(row.pageId), label: row.label, proxy: row.url === null ? null : { url: row.url, encryptedAuth: row.auth } };
}

/** The active Fansly pages with no browser profile: those that may move to
 *  their browser, each with its own proxy as stored (its auth sealed). */
export async function listPagesWithoutBrowser(db: Database): Promise<Array<{
  pageId: number;
  label: string;
  proxy: { url: string; encryptedAuth: string | null } | null;
}>> {
  const result = await db.execute<{ pageId: string; label: string; url: string | null; auth: string | null }>(sql`
    select p.id::text as "pageId", p.label, e.url, e.encrypted_auth as auth
      from pages p
      left join egress_endpoints e on e.platform_account_id = p.id
     where p.platform = 'fansly' and p.status = 'active'
       and not exists (select 1 from page_browsers b where b.page_id = p.id)
     order by p.label
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.pageId),
    label: row.label,
    proxy: row.url === null ? null : { url: row.url, encryptedAuth: row.auth },
  }));
}
