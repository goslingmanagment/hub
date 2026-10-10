import { expect, it } from "vitest";

import { settleNotificationDeliveryOutboxAttempt } from "@agency_hub_core/db";

import { runMigrations } from "../packages/db/src/migrate-runner.ts";
import { startIntegrationTestDatabase } from "./helpers/db.ts";

// Д2: a deploy in the middle of a Telegram outage must not keep the old loss.
// A `resolved` row with four failures out of five would exhaust on its fifth,
// and the sweep never returns to a page it has closed; 0263 gives the alerts
// still in the queue the new horizon and leaves everything else alone.
it("a queue standing at deploy time gets the new horizon", async () => {
  const db = await startIntegrationTestDatabase({ through: "0261_sync_raw_payloads_link_fans_idx.sql" });
  if (!db) throw new Error("Docker Postgres required");
  try {
    const incidents = await db.pool.query<{ id: string; incident_key: string }>(`
      insert into notification_incidents (incident_key, kind, status)
      values ('fansly_sync_engine:4:live_degraded', 'fansly_sync_engine', 'open'),
             ('ai_provider_failed:global:anthropic', 'ai_provider_failed', 'open')
      returning id, incident_key`);
    const [sync, ai] = incidents.rows.map((row) => Number(row.id));
    const rows: Array<[string, number, string, string, string, number]> = [
      // name, incident, transition, paging_policy, state, attempt_count
      ["opened", sync!, "opened", "sync_failure", "pending", 4],
      ["resolved", sync!, "resolved", "sync_failure", "pending", 4],
      ["in flight", sync!, "reopened", "sync_failure", "leased", 2],
      ["ai", ai!, "opened", "ai_critical", "pending", 4],
      ["delivered", sync!, "opened", "sync_failure", "delivered", 1],
      ["exhausted", sync!, "reopened", "sync_failure", "exhausted", 5],
    ];
    const ids = new Map<string, number>();
    for (const [index, [name, incident, transition, policy, state, attempts]] of rows.entries()) {
      const transitionAt = new Date(Date.UTC(2026, 9, 5, 15, 30 + index));
      const inserted = await db.pool.query<{ id: string }>(`
        insert into notification_delivery_outbox
          (notification_incident_id, transition, transition_at, channel, paging_policy, idempotency_key,
           message_text, state, attempt_count, max_attempts, lease_token, lease_expires_at)
        values ($1, $2, $3, 'telegram', $4, $5, $6, $7, $8, 5, $9, $10)
        returning id`, [
        incident, transition, transitionAt, policy,
        `notification:${incident}:${transition}:${transitionAt.toISOString()}:telegram`, `🚨 ${name}`, state, attempts,
        state === "leased" ? "in-flight-token" : null,
        state === "leased" ? new Date(transitionAt.getTime() + 300_000) : null,
      ]);
      ids.set(name, Number(inserted.rows[0]!.id));
    }

    const client = await db.pool.connect();
    try { await runMigrations({ db: client }); } finally { client.release(); }

    const after = await db.pool.query<{ message_text: string; max_attempts: number; reported_in_outbox_id: string | null }>(
      "select message_text, max_attempts, reported_in_outbox_id from notification_delivery_outbox order by id",
    );
    expect(after.rows.map((row) => [row.message_text, row.max_attempts, row.reported_in_outbox_id])).toEqual([
      ["🚨 opened", 400, null],
      ["🚨 resolved", 400, null],
      ["🚨 in flight", 400, null],
      ["🚨 ai", 5, null],
      ["🚨 delivered", 5, null],
      ["🚨 exhausted", 5, null],
    ]);

    // One more failure leaves the recovery in the queue; with the old cap of
    // five it would be exhausted, and nothing would ever announce it.
    await db.pool.query(
      `update notification_delivery_outbox set state = 'leased', lease_token = 'deploy-token',
         lease_expires_at = now() + interval '5 minutes' where id = $1`,
      [ids.get("resolved")],
    );
    const settled = await settleNotificationDeliveryOutboxAttempt(db.db, {
      outboxId: ids.get("resolved")!,
      leaseToken: "deploy-token",
      delivery: { status: "failed", error: "Telegram API request timed out through the service proxy." },
    });
    expect(settled).toMatchObject({ state: "pending", attemptCount: 5, maxAttempts: 400 });
  } finally { await db.stop(); }
}, 60_000);
