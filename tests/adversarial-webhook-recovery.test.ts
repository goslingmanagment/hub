import { describe, expect, it, vi } from "vitest";

vi.mock("../apps/dashboard/src/api/adminOfapiWebhookRecovery.ts", () => ({ useOfapiWebhookRecovery: vi.fn(), ofapiWebhookRecoveryActions: {} }));
import { webhookCanPrepareNewAction, webhookReadbackResolvesAction } from "../apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx";

describe("lost webhook apply response from an already failed policy", () => {
  const baseline = { version: 7, applyState: "failed" };
  const unchangedReadback = { ...baseline };

  it("keeps the old outcome unknown but permits a separately acknowledged new intent", () => {
    // The API has no attempt id: both a late old snapshot and another failed
    // application have this same response. Do not reinterpret it as refusal.
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
    const reviewed = { ...unchangedReadback, appliedGroups: [], errorCode: "old" };
    const changed = { ...reviewed, errorCode: "new" };
    expect(webhookCanPrepareNewAction(reviewed, changed, true, false)).toBe(false);
  });
});
