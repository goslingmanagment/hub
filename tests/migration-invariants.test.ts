import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { LINK_FAN_JOURNAL_ENDPOINTS_SQL, OFAPI_SPEND_PROJECTION_EVENT_TYPES } from "@agency_hub_core/db";
import { LINK_FAN_JOURNAL_ENDPOINTS } from "@agency_hub_core/shared";

describe("database migration invariants", () => {
  it("keeps OFAPI spend projection history when a page is deleted", async () => {
    const migration = await readFile(
      "packages/db/migrations/0049_audit_final_l17_operational_edges.sql",
      "utf8",
    );

    expect(migration).toContain('ALTER COLUMN "page_id" DROP NOT NULL');
    expect(migration).toContain("ON DELETE SET NULL");
    expect(migration).not.toContain("ON DELETE CASCADE");
  });

  it("keeps the spend-candidate index predicate equal to the sweep's pinned event types", async () => {
    const migration = await readFile(
      "packages/db/migrations/0143_ofapi_webhook_events_spend_candidates_idx.sql",
      "utf8",
    );

    // The planner may only use a partial index when the query's clauses IMPLY
    // its predicate, and implication over a list of constants is structural: a
    // list that differs in content OR ORDER stops the index being used, and the
    // only symptom is that the minutely sweep silently goes back to walking the
    // whole journal. Pin the predicate to the one constant the query is built
    // from — same members, same order.
    const predicate = /where event_type in \(([^)]*)\)/.exec(migration)?.[1];
    expect(predicate).toBeDefined();
    const indexedEventTypes = predicate!
      .split(",")
      .map((value) => value.trim().replace(/^'|'$/g, ""));
    expect(indexedEventTypes).toEqual([...OFAPI_SPEND_PROJECTION_EVENT_TYPES]);

    // The rest of the predicate is the sweep's other two constant clauses,
    // verbatim, and the key is `id` alone so the same index serves `order by id`.
    expect(migration).toContain("on ofapi_webhook_events (id)");
    expect(migration).toContain("and status <> 'pending'");
    expect(migration).toContain("and platform_account_id is not null");

    // Capture-first (DP 7): building this index must never lock out the webhook
    // receiver, so it is non-transactional and CONCURRENTLY.
    expect(migration.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(migration).toContain("create index concurrently if not exists");
    expect(migration).toContain(
      "drop index concurrently if exists %I.%I",
    );
  });

  it("keeps the money-stamp index predicate equal to the constant its probe spells", async () => {
    const migration = await readFile(
      "packages/db/migrations/0250_ofapi_webhook_events_transactions_page_received_idx.sql",
      "utf8",
    );
    const repository = await readFile("packages/db/src/repositories/ofapi.ts", "utf8");

    // The probe in getOfapiMoneyStreamStates must imply the predicate, so both
    // spell the same constant; a bound parameter or another type silently
    // sends the probe back to walking every delivery of the page.
    expect(migration).toContain("on ofapi_webhook_events (platform_account_id, received_at)");
    expect(migration).toContain("where event_type = 'transactions.new';");
    expect(repository).toContain("where ${ofapiWebhookEvents.eventType} = 'transactions.new'");

    // Capture-first (DP 7): never lock out the webhook receiver.
    expect(migration.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(migration).toContain(
      "create index concurrently if not exists ofapi_webhook_events_transactions_page_received_idx",
    );
    expect(migration).toContain("drop index concurrently if exists %I.%I");
    expect(migration).toContain("where i.relname = 'ofapi_webhook_events_transactions_page_received_idx'");
    expect(migration.split("-- agency-hub:statement").length - 1).toBe(2);
  });

  it("builds the link ↔ fan journal index concurrently, on exactly the projection's endpoint list", async () => {
    const index = await readFile("packages/db/migrations/0261_sync_raw_payloads_link_fans_idx.sql", "utf8");
    const reader = await readFile("packages/db/src/repositories/link-fans.ts", "utf8");

    // Every lane writes sync_raw_payloads; a plain build would block them.
    expect(index.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(index).toContain("drop index concurrently if exists %I.%I");
    expect(index).toContain("where i.relname = 'sync_raw_payloads_link_fans_idx'");
    expect(index).toContain("create index concurrently if not exists sync_raw_payloads_link_fans_idx");
    expect(index).toContain("on sync_raw_payloads (page_id, id)");
    expect(index.split("-- agency-hub:statement").length - 1).toBe(2);

    // The partial predicate is a contract with the reader: it spells the same
    // list as SQL constants (a bound parameter would not imply the predicate).
    const predicate = /where endpoint in \(([^)]*)\)/.exec(index)?.[1];
    expect(predicate!.split(",").map((value) => value.trim().replace(/^'|'$/g, "")))
      .toEqual([...LINK_FAN_JOURNAL_ENDPOINTS]);
    expect(LINK_FAN_JOURNAL_ENDPOINTS_SQL).toBe(`(${predicate})`);
    expect(reader).toContain("rp.endpoint in ${sql.raw(LINK_FAN_JOURNAL_ENDPOINTS_SQL)}");

    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    const compatible = deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0];
    expect(compatible).toContain('"0260_page_link_fans.sql"');
    expect(compatible).toContain('"0261_sync_raw_payloads_link_fans_idx.sql"');
  });

  it("keeps when a Hub request was let go and released, and the exit's refusals (0290): nullable, under brief retried locks, readable by the read role, rollback-compatible", async () => {
    const statementsOf = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    const text = await readFile("packages/db/migrations/0290_page_browser_quiet_and_egress.sql", "utf8");
    expect(text.startsWith("-- agency-hub:no-transaction")).toBe(true);
    const sqlText = statementsOf(text);
    for (const column of ["granted_at timestamptz", "released_at timestamptz", "egress_failures jsonb", "egress_failures_since timestamptz"]) {
      expect(sqlText).toContain(`add column if not exists ${column}`);
    }
    // Nullable columns without a default: catalog only, under a 1 s lock retried.
    expect(sqlText).not.toMatch(/add column[^,;]*\b(not null|default)\b/i);
    expect(sqlText.match(/set local lock_timeout = '1s';/g)).toHaveLength(2);
    expect(sqlText).not.toMatch(/^\s*(update|insert|delete)\b/im);
    expect(sqlText).toContain("grant select (egress_failures, egress_failures_since) on page_browsers to read_only;");
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain('"0290_page_browser_quiet_and_egress.sql"');
  });
});
