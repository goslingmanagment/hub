import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  capturePayloadBucketMonth: (instant: Date) =>
    `${instant.getUTCFullYear()}-${String(instant.getUTCMonth() + 1).padStart(2, "0")}-01`,
  ensureCapturePayloadCatalogPartitions: vi.fn(),
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
  dbMocks.ensureCapturePayloadCatalogPartitions.mockReset();
  dbMocks.ensureCapturePayloadCatalogPartitions.mockResolvedValue([]);
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

  it("extends the CAS catalog months on the same lead as observations", async () => {
    dbMocks.ensureObservationPartitions.mockResolvedValue([]);
    dbMocks.getObservationPartitionLeadMonths.mockResolvedValue(3);
    dbMocks.ensureCapturePayloadCatalogPartitions.mockImplementation(
      async (_db: unknown, month: string) => [
        `capture_payload_objects_${month.slice(0, 7).replace("-", "_")}`,
      ],
    );

    const result = await runObservationsPartitionCheck(
      appStub(),
      new Date("2026-11-15T03:10:00Z"),
    );

    // The catalog got monthly partitions ONLY from migration 0123 (through
    // 2027-02, then the 2031 catch-all) and nothing extended them: from
    // 2027-03 every live catalog write would fail 23514 and capture would
    // silently fall back to inline bodies.
    expect(
      dbMocks.ensureCapturePayloadCatalogPartitions.mock.calls.map(([, month]) => month),
    ).toEqual(["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
    expect(result.ensured).toContain("capture_payload_objects_2027_02");
    expect(result.failed).toBe(false);
  });

  it("pages when the catalog's own pre-creation fails", async () => {
    dbMocks.ensureObservationPartitions.mockResolvedValue([]);
    dbMocks.getObservationPartitionLeadMonths.mockResolvedValue(3);
    dbMocks.ensureCapturePayloadCatalogPartitions.mockRejectedValue(
      new Error("must be owner of table capture_payload_objects"),
    );

    const result = await runObservationsPartitionCheck(appStub());

    // The catalog has no lead query, so the FAILURE is the only signal there
    // is — and the dual-write swallows the 23514 that follows.
    expect(result.failed).toBe(true);
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    const [, input] = incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]!;
    expect(input.errorSummary).toContain("capture_payload_objects");
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
