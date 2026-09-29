import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { beginFanslyWsConnection, finishFanslyWsConnection, getConfigOverrides,
  setConfigOverridesAtomic } from "@agency_hub_core/db";
import { applyFanslyWsPolicyRepair, previewFanslyWsPolicyRepair } from "../apps/runtime/src/services/fansly-ws-policy-repair.ts";
import * as binding from "../apps/runtime/src/services/egress/fansly-binding-preflight.ts";
import { readProbeGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";
import { getPageSyncBlocks, getSyncBlocksOverview } from "../apps/runtime/src/services/sync-blocks.ts";
import { getPublicSyncHealth } from "../apps/runtime/src/services/health.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let db: Awaited<ReturnType<typeof startTestDatabase>>;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });
afterEach(() => vi.restoreAllMocks());
const matched: binding.BindingInspection = {
  identityMatched: true, observedAccountId: "999", httpStatus: 200, restRequests: 1, reason: "matched",
};

async function fixture() {
  const app = createTestAppContext(db);
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!page) throw new Error("missing page");
  await db.pool.query("update pages set external_page_id='999' where id=$1", [page.id]);
  await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
  const generation = await readProbeGeneration(app.db, page.label);
  Object.assign(app.config, { fanslyWsCaptureEnabled: true, fanslyWsCapturePageAllowlist: page.label,
    fanslyWsHintsEnabled: true, fanslyWsHintsPageAllowlist: page.label, fanslyWsHintsTypeAllowlist: "message_created" });
  const policy = { generation: "a".repeat(64), activationAt: "2026-01-01T00:00:00Z",
    baselineAttempts24h: 1000, attemptLimit24h: 20, baselineReference: "frozen evidence" };
  const policies = { [page.label]: policy, sibling: { ...policy, baselineReference: "sibling evidence" } };
  const patch = async (changes: Record<string, unknown>) => {
    const rows = await getConfigOverrides(db.db);
    const current = JSON.parse(rows.get("fanslyWsHintsPolicies")?.value as string ?? JSON.stringify(policies));
    current[page.label] = { ...current[page.label], ...changes };
    await setConfigOverridesAtomic(db.db, { patches: [{ key: "fanslyWsHintsPolicies", value: JSON.stringify(current) }],
      userId: null, groupId: randomUUID() });
  };
  await patch({});
  const inspect = vi.spyOn(binding, "inspectFanslyBinding").mockResolvedValue(matched);
  const preview = () => previewFanslyWsPolicyRepair(app, page.label);
  const auditCount = async () => (await db.pool.query("select count(*)::int n from config_audit_log")).rows[0].n;
  return { app, page, generation, policies, patch, inspect, preview, auditCount };
}

describe("checked Fansly B1 generation repair", () => {
  it("verifies account binding, changes only one generation, audits once and preserves budget and sibling policy", async () => {
    const f = await fixture();
    await db.pool.query("insert into fansly_ws_hint_attempts(page_id,request_id,attempt_number,generation) values ($1,'prior',1,$2)", [f.page.id, f.policies[f.page.label]!.generation]);
    const preview = await f.preview();
    expect(preview.state).toBe("ready");
    expect(preview.connection).toBeNull(); // auth-shaped socket metadata is not account proof
    expect(await f.auditCount()).toBe(1);
    expect(await applyFanslyWsPolicyRepair(f.app, preview.proposal)).toEqual({ state: "applied" });
    expect(await applyFanslyWsPolicyRepair(f.app, preview.proposal)).toEqual({ state: "already_applied" });
    expect(await f.auditCount()).toBe(2);
    const current = JSON.parse((await getConfigOverrides(db.db)).get("fanslyWsHintsPolicies")!.value as string);
    expect(current).toEqual({ ...f.policies, [f.page.label]: { ...f.policies[f.page.label], generation: f.generation } });
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(1);
    expect(f.inspect).toHaveBeenCalledTimes(3);
    for (const [input] of f.inspect.mock.calls) expect(input).toMatchObject({ expectedAccountId: "999" });
  });
  it.each(["version", "gate", "rotation", "account", "expired_preview", "canary", "auth_refused"])("refuses %s changes with no repair writes", async kind => {
    const f = await fixture();
    const preview = await f.preview();
    if (!preview.proposal) throw new Error("missing proposal");
    if (kind === "version") await f.patch({ baselineReference: "new evidence" });
    if (kind === "gate") f.app.config.fanslyWsHintsEnabled = false;
    if (kind === "rotation") await saveProxy(f.app, f.page.id, { url: "http://other.example.test:8080" });
    if (kind === "account") f.inspect.mockResolvedValue({ ...matched, identityMatched: false, observedAccountId: "888", reason: "account_mismatch" });
    if (kind === "expired_preview") preview.proposal.expiresAt = "2026-01-01T00:00:00Z";
    if (kind === "canary") await f.patch({ expiresAt: "2099-01-01T00:00:00Z" });
    if (kind === "auth_refused") {
      const id = randomUUID();
      await beginFanslyWsConnection(db.db, { id, pageId: f.page.id, generation: f.generation });
      await finishFanslyWsConnection(db.db, id, "auth_refused");
    }
    const count = await f.auditCount();
    const before = await getConfigOverrides(db.db);
    await expect(applyFanslyWsPolicyRepair(f.app, preview.proposal)).rejects.toThrow();
    expect(await f.auditCount()).toBe(count);
    expect(await getConfigOverrides(db.db)).toEqual(before);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(0);
  });
  it("rechecks generation under the lock after the identity HTTP request", async () => {
    const f = await fixture(); const preview = await f.preview();
    f.inspect.mockImplementationOnce(async () => {
      await saveProxy(f.app, f.page.id, { url: "http://rotated.example.test:8080" });
      return matched;
    });
    await expect(applyFanslyWsPolicyRepair(f.app, preview.proposal)).rejects.toThrow("generation_changed");
    expect(await f.auditCount()).toBe(1);
  });
  it("does not authorize a preview on mismatched account or accepted socket frame alone", async () => {
    const f = await fixture();
    const id = randomUUID(); await beginFanslyWsConnection(db.db, { id, pageId: f.page.id, generation: f.generation });
    await db.pool.query("update fansly_ws_connections set verified_at=now(),last_guard_at=now() where id=$1", [id]);
    f.inspect.mockResolvedValue({ ...matched, identityMatched: false, observedAccountId: "888", reason: "account_mismatch" });
    expect(await f.preview()).toMatchObject({ state: "blocked", proposal: null, blockers: ["binding:account_mismatch"] });
  });
  it("does not spend a binding request when the policy already matches", async () => {
    const f = await fixture(); await f.patch({ generation: f.generation });
    expect(await f.preview()).toMatchObject({ state: "already_matching", proposal: null, binding: null });
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("shows a generation mismatch in detailed metrics without changing deploy health", async () => {
    const f = await fixture();
    const mismatchedHealth = await getPublicSyncHealth(f.app, { pageIds: [f.page.id] });
    const snapshot = await getSyncStatusSnapshot(f.app, { pageIds: [f.page.id], includeMonitorRows: false });
    expect(snapshot.pages[0]?.blocks.messages_live.metrics.fanslyWsHints).toMatchObject({ state: "generation_mismatch" });
    f.app.config.fanslyWsHintsEnabled = false;
    const off = await getSyncStatusSnapshot(f.app, { pageIds: [f.page.id], includeMonitorRows: false });
    expect(off.pages[0]?.blocks.messages_live.metrics.fanslyWsHints).toEqual({ state: "inactive" });
    const offHealth = await getPublicSyncHealth(f.app, { pageIds: [f.page.id] });
    expect(mismatchedHealth.body.pages.map(p => p.issues)).toEqual(offHealth.body.pages.map(p => p.issues));
  });
  it("keeps the mismatch on the dashboard sync surfaces until the checked re-pin, then clears it", async () => {
    const f = await fixture();
    const overview = async () => (await getSyncBlocksOverview(f.app, { pageIds: [f.page.id] }))
      .pages[0]?.blocks.messages_live.metrics.fanslyWsHints;
    const detail = async () => (await getPageSyncBlocks(f.app, { pageLabel: f.page.label }))
      .page.blocks.messages_live.metrics.fanslyWsHints;
    expect(await overview()).toMatchObject({ state: "generation_mismatch", currentGeneration: f.generation });
    expect(await detail()).toMatchObject({ state: "generation_mismatch" });
    const preview = await f.preview();
    expect(await applyFanslyWsPolicyRepair(f.app, preview.proposal)).toEqual({ state: "applied" });
    expect(await overview()).toMatchObject({ state: "matching", configuredGeneration: f.generation });
    expect(await detail()).toMatchObject({ state: "matching" });
  });
});
