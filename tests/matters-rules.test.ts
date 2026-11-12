import { describe, expect, it } from "vitest";

import type { SyncBlocksPage, SyncPagesResponse, TeamLedgerPayoutsResponse, TeamLedgerReportsResponse } from "@agency_hub_core/contracts";
import { pendingChangesOf, reportQuestionsWindow as screenWindow, unparsedPostsToDecide } from "@agency_hub_core/ui/shiftReports";

import { isOfapiOffFailure } from "../apps/dashboard/src/lib/failures.ts";
import { engineStatusState } from "../apps/dashboard/src/pages/settings/engine/engineDisplay.ts";
import { enginePageStatus } from "../apps/dashboard/src/pages/settings/engine/enginePageSummary.ts";
import {
  isOfapiOffIncident,
  loginPageLabels,
  paidDayChangeItems,
  reportPostItems,
  reportQuestionsWindow,
} from "../apps/runtime/src/services/matters-mirror.ts";
import { buildDecisions, buildWaitingRows, type MatterKindState } from "../apps/runtime/src/services/matters.ts";

// The mirror of «Ждут вас» and «Решения» (package D) ports the screens' rules
// to the server. A port that drifts from its screen is a count that differs
// in silence: each rule runs here beside its original on the same answers.

const stop = (by: string[], reason = "page_hold") => ({ reason, by, resources: [], until: null });
const block = (stops: ReturnType<typeof stop>[] = []) => ({ state: "engine", engine: { stopped: stops.length > 0 ? "some" : "none", stops, paused: false } });
const idle = { state: "legacy" };
function page(label: string, platform: string, blocks: Partial<Record<string, unknown>> = {}): SyncBlocksPage {
  const all = { connection: idle, financials: idle, audience: idle, messages_live: idle, messages_history: idle, ...blocks };
  return { pageId: 1, pageLabel: label, platform, blocks: all } as unknown as SyncBlocksPage;
}
function status(label: string, mode: string, login: boolean | null): SyncPagesResponse["pages"][number] {
  return {
    pageLabel: label, mode, owner: { running: true, heartbeatAt: null }, holds: { page: null },
    ...(login === null ? {} : { browser: { login: { needed: login, why: login ? "login_required" : null }, proxy: { problem: null } } }),
  } as unknown as SyncPagesResponse["pages"][number];
}

describe("the matters mirror keeps the screens' rules", () => {
  it("finds the same Fansly pages that need a login as the console", () => {
    const blocks = [
      page("signed-out", "fansly"),
      page("refused", "fansly", { connection: block([stop(["auth"])]) }),
      page("other-account", "fansly", { messages_live: block([stop(["identity_mismatch"])]) }),
      page("network", "fansly", { financials: block([stop(["network"])]) }),
      page("paused", "fansly", { audience: block([stop(["page"], "paused")]) }),
      page("handover-login", "fansly"),
      page("off-login", "fansly"),
      page("fine", "fansly", { connection: block() }),
      page("onlyfans", "onlyfans", { connection: block([stop(["auth"])]) }),
    ];
    const engine = [
      status("signed-out", "live", true),
      status("refused", "live", false),
      status("handover-login", "handover", true),
      status("off-login", "off", true),
      status("fine", "live", false),
    ];
    const screen = blocks
      .filter((one) => one.platform === "fansly")
      .filter((one) => enginePageStatus(one, engineStatusState(engine.find((candidate) => candidate.pageLabel === one.pageLabel))).kind === "login")
      .map((one) => one.pageLabel);
    expect(loginPageLabels(blocks, engine)).toEqual(screen);
    expect(screen).toEqual(["signed-out", "refused", "other-account", "handover-login"]);
  });

  it("leaves out the same failures of the switched-off OnlyFans API", () => {
    const incidents = [
      { kind: "ofapi_auth", platform: null, incidentKey: "ofapi_auth:global" },
      { kind: "ofapi_platform_notice", platform: "onlyfans", incidentKey: "ofapi_platform_notice:8" },
      { kind: "read_gateway_capture", platform: "onlyfans", incidentKey: "read_gateway_capture:9:collection_stale" },
      { kind: "chatspace_tab", platform: "onlyfans", incidentKey: "chatspace_tab:9:silent" },
      { kind: "golden_signal_lag", platform: null, incidentKey: "golden_signal_lag:global:ofapi_delivery_history_age" },
      { kind: "fansly_sync_engine", platform: "fansly", incidentKey: "fansly_sync_engine:10:page_stopped" },
      { kind: "db_disk_usage", platform: null, incidentKey: "db_disk_usage:global" },
    ] as const;
    for (const incident of incidents) {
      expect(isOfapiOffIncident(incident), incident.incidentKey).toBe(isOfapiOffFailure(incident as never));
    }
  });

  it("asks the ledger about the same posts and changed days as Решения, over the same window", () => {
    expect(reportQuestionsWindow("2026-11-12")).toEqual(screenWindow("2026-11-12"));
    expect(reportQuestionsWindow("2026-03-01")).toEqual(screenWindow("2026-03-01"));
    const post = (id: number, blocking: boolean, reportDate: string | null, postedAt: string, labels: Array<string | null>) => ({
      id, blocking, reportDate, postedAt, flags: blocking ? ["unknown_author"] : ["duplicate"], totalMills: 1000, link: null,
      pages: labels.map((pageLabel) => ({ name: "x", pageLabel, inShift: true, amountMills: 500 })),
    });
    const reports = {
      posts: [
        post(1, true, "2026-11-10", "2026-11-10T20:00:00Z", ["page-a"]),
        post(2, true, "2026-11-08", "2026-11-09T01:00:00Z", ["page-a", "page-b"]),
        post(3, false, "2026-11-11", "2026-11-11T20:00:00Z", []),
        // No date read: the Moscow day it was posted (21:30 UTC on the 8th is the 9th in Moscow).
        post(4, true, null, "2026-11-08T21:30:00Z", [null]),
        post(5, true, null, "2026-11-08T20:30:00Z", []),
      ],
    } as unknown as TeamLedgerReportsResponse;
    const payouts = {
      reportsFrom: "2026-11-09",
      people: [
        { slug: "a", name: "A", hubUser: { userId: 3, username: "a" }, pendingChanges: [{ id: 7, day: "2026-11-01", model: "m", postedMills: 1, newMills: 2, reason: "" }] },
        { slug: "b", name: "B", hubUser: null, pendingChanges: [] },
      ],
    } as unknown as TeamLedgerPayoutsResponse;
    expect(reportPostItems(reports, payouts).map((item) => Number(item.object!.id))).toEqual(unparsedPostsToDecide(reports, payouts).map((one) => one.id));
    expect(reportPostItems(reports, { reportsFrom: null } as never)).toEqual([]);
    expect(paidDayChangeItems(payouts).map((item) => Number(item.object!.id))).toEqual(pendingChangesOf(payouts).map((one) => one.id));
  });

  it("counts «Ждут вас» and «Решения» as the screens do: a source without an answer is not a zero, a page cuts only Решения", () => {
    const known: MatterKindState = { checked: true, applicable: true, capped: false };
    const matters = [
      { id: 1, kind: "send.held", pageIds: [10], evidence: {} },
      { id: 2, kind: "send.held", pageIds: [11], evidence: {} },
      { id: 3, kind: "ledger.paid_day_changed", pageIds: [], evidence: {} },
      { id: 4, kind: "ledger.report_post", pageIds: [11], evidence: {} },
      { id: 5, kind: "page.login_needed", pageIds: [10], evidence: {} },
      { id: 6, kind: "extension.critical", pageIds: [], evidence: { total: 3 } },
      { id: 7, kind: "history.request", pageIds: [10], evidence: {} },
    ];
    const kindState = (kind: string): MatterKindState => (kind === "ledger.sale_question" ? { ...known, checked: false }
      : kind === "history.request" ? { ...known, applicable: false } : known);
    const owner = buildWaitingRows({ role: "owner", matters, kindState, labelOf: (id) => `p${id}` });
    expect(owner.rows.map((row) => [row.id, row.count])).toEqual([["questions", null], ["reports", 2], ["held", 2], ["login", 1], ["extension", 3]]);
    expect(owner.rows.find((row) => row.id === "login")).toMatchObject({ pageLabel: "p10", to: "/workboard/decisions#system" });
    expect(owner.total).toBe(8);
    expect(owner.failed).toEqual(["questions"]);
    expect(buildWaitingRows({ role: "team_lead", matters, kindState, labelOf: () => undefined }).rows.map((row) => row.id)).toEqual(["held"]);

    const onPage = buildDecisions({ role: "owner", matters, kindState, pageId: 10 });
    expect(onPage).toMatchObject({ questions: null, reports: 1, reportParts: { posts: 0, changes: 1 }, customs: 0, held: 1, failed: ["questions"] });
    // The other page's post and send; the changed day is on every page.
    expect(onPage.elsewhere).toBe(2);
    expect(buildDecisions({ role: "team_lead", matters, kindState, pageId: null })).toMatchObject({ questions: null, reports: null, held: 2, failed: [] });
  });
});
