import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  ensureDomainEventPartitions: vi.fn(),
  ensureObservationPartitions: vi.fn(),
  getDomainEventPartitionLeadMonths: vi.fn(),
  getObservationPartitionLeadMonths: vi.fn(),
}));

const incidentMocks = vi.hoisted(() => ({
  notifyOfapiGlobalIncident: vi.fn(),
  resolveOfapiGlobalIncident: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/services/notification-incidents.ts", () => incidentMocks);

import {
  OBSERVATION_PARTITION_LEAD_FLOOR_MONTHS,
  runObservationsPartitionCheck,
} from "../apps/runtime/src/services/observations-partitions.ts";

function appStub() {
  return {
    config: {},
    db: {},
    logger: { warn: vi.fn(), info: vi.fn() },
  } as never;
}

beforeEach(() => {
  dbMocks.ensureObservationPartitions.mockReset();
  dbMocks.getObservationPartitionLeadMonths.mockReset();
  dbMocks.ensureDomainEventPartitions.mockReset();
  dbMocks.getDomainEventPartitionLeadMonths.mockReset();
  // Stage 8: the same job maintains the events ledger; healthy by default so
  // existing cases keep exercising the observations-side branches.
  dbMocks.ensureDomainEventPartitions.mockResolvedValue([]);
  dbMocks.getDomainEventPartitionLeadMonths.mockResolvedValue(12);
  incidentMocks.notifyOfapiGlobalIncident.mockReset();
  incidentMocks.resolveOfapiGlobalIncident.mockReset();
});

describe("runObservationsPartitionCheck", () => {
  it("resolves the incident when pre-creation succeeds and the lead is healthy", async () => {
    dbMocks.ensureObservationPartitions.mockResolvedValue(["observations_2026_07"]);
    dbMocks.getObservationPartitionLeadMonths.mockResolvedValue(3);

    const result = await runObservationsPartitionCheck(appStub(), new Date("2026-07-05T03:10:00Z"));

    expect(result).toEqual({ ensured: ["observations_2026_07"], leadMonths: 3, failed: false });
    expect(incidentMocks.notifyOfapiGlobalIncident).not.toHaveBeenCalled();
    expect(incidentMocks.resolveOfapiGlobalIncident).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: "observations_partitions",
    }));
  });

  it("pages when the lead shrinks below the floor", async () => {
    dbMocks.ensureObservationPartitions.mockResolvedValue([]);
    dbMocks.getObservationPartitionLeadMonths.mockResolvedValue(OBSERVATION_PARTITION_LEAD_FLOOR_MONTHS - 1);

    await runObservationsPartitionCheck(appStub());

    expect(incidentMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    const [, input] = incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]!;
    expect(input.kind).toBe("observations_partitions");
    expect(input.errorSummary).toContain("below the 2-month floor");
  });

  it("pages when pre-creation itself fails, even if existing lead looks fine", async () => {
    dbMocks.ensureObservationPartitions.mockRejectedValue(new Error("permission denied"));
    dbMocks.getObservationPartitionLeadMonths.mockResolvedValue(3);

    const result = await runObservationsPartitionCheck(appStub());

    expect(result.failed).toBe(true);
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    const [, input] = incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]!;
    expect(input.errorSummary).toContain("permission denied");
  });
});
