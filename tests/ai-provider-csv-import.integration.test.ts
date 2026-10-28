import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  listAiProviderAccounts,
  listAiProviderKeyMappings,
  listAiProviderReports,
  setAiProviderKeyMapping,
  syncAiProviderAccounts,
  type Database,
} from "@agency_hub_core/db";

import { importAnthropicCostCsv } from "../apps/runtime/src/services/ai-provider-csv-import.ts";
import { loadReconciliation } from "../apps/runtime/src/services/ai-provider-reconciliation.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// The console's Cost CSV through the database: a re-imported day replaces
// the old file's lines, a day the new file covers without spend becomes
// empty, and a key's decision outlives the import that made it.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

const db = () => testDb!.db as unknown as Database;
const HEADER = "usage_date_utc,model,workspace,api_key,usage_type,context_window,token_type,cost_usd,list_price_usd,cost_type,inference_geo,speed,api_key_id,api_key_status";
const row = (day: string, name: string, id: string, dollars: string, tokenType = "output") =>
  `${day},Claude Opus 5.5,Default,${name},message,≤ 200k,${tokenType},${dollars},${dollars},token,global,standard,${id},`;

describe("importing the console's Cost CSV", () => {
  it("replaces the days a new file covers and keeps every key's decision", async () => {
    await syncAiProviderAccounts(db(), {
      provider: "anthropic",
      accounts: [{ label: "oag", keyFingerprint: "fp-oag", keyHint: "oag1" }],
      at: new Date("2026-10-28T00:00:00Z"),
    });
    const [account] = await listAiProviderAccounts(db(), "anthropic");
    const app = { db: db(), config: { anthropicApiKeys: [{ label: "oag", apiKey: "sk-ant-usr-oag" }] } as never };
    const importFile = (csv: string, at: string) => importAnthropicCostCsv(app, {
      account: { label: "oag" }, csv, fileName: "cost.csv", source: "cli", now: new Date(at), resolveOrgId: async () => "org_oag",
    });

    await importFile([
      HEADER,
      row("2026-10-26", "goose", "apikey_goose", "2.00"),
      row("2026-10-27", "hub", "apikey_hub", "45.20"),
      row("2026-10-27", "hub", "apikey_hub", "0.57", "input_no_cache"),
      row("2026-10-28", "hub", "apikey_hub", "3.00"),
    ].join("\n"), "2026-10-28T10:00:00Z");
    // The owner says goose was Hub's (it was, until the 17th).
    await setAiProviderKeyMapping(db(), { orgId: "org_oag", apiKeyId: "apikey_goose", accountId: account!.id, at: new Date("2026-10-28T11:00:00Z") });

    // A later export: the 27th settled higher, the 28th has no spend.
    await importFile([
      HEADER,
      row("2026-10-26", "goose", "apikey_goose", "2.00"),
      row("2026-10-27", "hub", "apikey_hub", "45.77"),
      row("2026-10-28", "hub", "apikey_hub", "0.00"),
    ].join("\n"), "2026-10-29T10:00:00Z");

    const reports = await listAiProviderReports(db(), { orgIds: ["org_oag"], fromDay: "2026-10-26", toDay: "2026-10-28" });
    const cents = (day: string) => reports.costs
      .filter((cost) => cost.day === day)
      .reduce((total, cost) => total + Number(cost.amountCents), 0);
    expect([cents("2026-10-26"), cents("2026-10-27"), cents("2026-10-28")]).toEqual([200, 4577, 0]);
    expect(reports.days.map((day) => [day.day, day.source]).sort()).toEqual([
      ["2026-10-26", "csv"], ["2026-10-27", "csv"], ["2026-10-28", "csv"],
    ]);

    // Re-importing never undoes the owner's decision; "hub" stays the account's.
    const mappings = await listAiProviderKeyMappings(db());
    expect(mappings.map((mapping) => [mapping.apiKeyId, mapping.accountId, mapping.source]).sort()).toEqual([
      ["apikey_goose", account!.id, "owner"],
      ["apikey_hub", account!.id, "name"],
    ]);

    const reconciliation = await loadReconciliation(app, { days: 4, now: new Date("2026-10-29T12:00:00Z") });
    const provider = (day: string) => reconciliation.rows.find((entry) => entry.day === day)?.providerMicroUsd;
    expect([provider("2026-10-26"), provider("2026-10-27"), provider("2026-10-28")]).toEqual([2_000_000, 45_770_000, 0]);
    expect(reconciliation.orgs[0]!.source).toMatchObject({ kind: "csv", periodFrom: "2026-10-26", periodTo: "2026-10-28", fileName: "cost.csv" });
  });
});
