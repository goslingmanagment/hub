import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The always-on ChatSpace tab's reports (0343; apps/chatspace-browser): raw
// SQL over chatspace_tab_reports, one row per install of the extension,
// overwritten by each report. The route (services/chatspace-tab-watch.ts)
// keeps only the server's hub user; the API's ops watchdog reads the newest.

export interface ChatspaceTabAccount {
  hostAccountId: string;
  pageLabel: string | null;
  covered: boolean;
  /** Since when `covered` holds, as the browser said it. */
  since: string;
}

export interface ChatspaceTabReport {
  userId: number;
  instanceId: string;
  /** The hub's clock when the report came. */
  reportedAt: Date;
  extensionVersion: string;
  route: string;
  accounts: ChatspaceTabAccount[];
}

export async function recordChatspaceTabReport(db: Database, report: ChatspaceTabReport): Promise<void> {
  await db.execute(sql`
    insert into chatspace_tab_reports (user_id, instance_id, reported_at, extension_version, route, accounts)
    values (${report.userId}, ${report.instanceId}, ${report.reportedAt.toISOString()}::timestamptz,
            ${report.extensionVersion}, ${report.route}, ${JSON.stringify(report.accounts)}::jsonb)
    on conflict (user_id, instance_id) do update set
      reported_at = excluded.reported_at,
      extension_version = excluded.extension_version,
      route = excluded.route,
      accounts = excluded.accounts`);
}

/** The user's newest report over its installs; null — none ever. */
export async function latestChatspaceTabReport(db: Database, userId: number): Promise<ChatspaceTabReport | null> {
  const result = await db.execute<{
    user_id: string | number;
    instance_id: string;
    reported_at: Date | string;
    extension_version: string;
    route: string;
    accounts: unknown;
  }>(sql`
    select user_id, instance_id, reported_at, extension_version, route, accounts
    from chatspace_tab_reports
    where user_id = ${userId}
    order by reported_at desc
    limit 1`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    userId: Number(row.user_id),
    instanceId: row.instance_id,
    reportedAt: new Date(row.reported_at),
    extensionVersion: row.extension_version,
    route: row.route,
    accounts: Array.isArray(row.accounts) ? (row.accounts as ChatspaceTabAccount[]) : [],
  };
}

/** The OnlyFans pages assigned to a user, as the tab's accounts must cover them. */
export async function chatspaceTabPagesOf(db: Database, userId: number): Promise<Array<{ pageId: number; pageLabel: string }>> {
  const result = await db.execute<{ page_id: string | number; label: string }>(sql`
    select a.platform_account_id as page_id, p.label
    from user_page_assignments a
    join pages p on p.id = a.platform_account_id
    where a.user_id = ${userId} and p.platform = 'onlyfans' and p.status = 'active'
    order by p.label`);
  return result.rows.map((row) => ({ pageId: Number(row.page_id), pageLabel: row.label }));
}
