import { describe, expect, it, vi } from "vitest";

vi.mock("../apps/dashboard/src/api/adminOfapiWebhookRecovery.ts", () => ({ useOfapiWebhookRecovery: vi.fn(), ofapiWebhookRecoveryActions: {} }));
import { webhookCanPrepareNewAction, webhookReadbackResolvesAction } from "../apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx";

describe.each(["failed", "applied"])("lost webhook apply response from an already %s policy", (state) => {
  const baseline = { version: 7, applyState: state };
  const unchangedReadback = { ...baseline };

  it("keeps the old outcome unknown but permits a separately acknowledged new intent", () => {
    // The API has no attempt id: both the old snapshot and another completed
    // application can have this same state. Neither proves the new outcome.
    expect(webhookReadbackResolvesAction(baseline, unchangedReadback)).toBe(false);
    expect(webhookCanPrepareNewAction(null, unchangedReadback, true, false)).toBe(false);
    expect(webhookCanPrepareNewAction(unchangedReadback, unchangedReadback, false, false)).toBe(false);
    expect(webhookCanPrepareNewAction(unchangedReadback, unchangedReadback, true, false)).toBe(true);
  });

  it("requires rereview after a changed snapshot or failed/in-flight refresh", () => {
    expect(webhookCanPrepareNewAction(unchangedReadback, unchangedReadback, true, true)).toBe(false);
    expect(webhookCanPrepareNewAction(unchangedReadback, { version: 8, applyState: "failed" }, true, false)).toBe(false);
    expect(webhookCanPrepareNewAction(unchangedReadback, { version: 7, applyState: "applying" }, true, false)).toBe(false);
    const applying = { version: 7, applyState: "applying" };
    expect(webhookCanPrepareNewAction(applying, applying, true, false)).toBe(false);
    expect(webhookReadbackResolvesAction(baseline, { version: 8, applyState: "applying" })).toBe(false);
    const reviewed = { ...unchangedReadback, appliedGroups: [], errorCode: "old" };
    const changed = { ...reviewed, errorCode: "new" };
    expect(webhookCanPrepareNewAction(reviewed, changed, true, false)).toBe(false);
  });
});
