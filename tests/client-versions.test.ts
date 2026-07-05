// Stage 4 fleet-verify data source: one log line per (version, address),
// counted thereafter — the exit check greps these lines in prod.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  recordClientVersionObservation,
  resetClientVersionObservationsForTests,
  snapshotClientVersionObservations,
} from "../apps/runtime/src/services/client-versions.ts";

describe("client version observer", () => {
  beforeEach(() => {
    resetClientVersionObservationsForTests();
  });

  it("logs once per (version, address) and counts repeats", () => {
    const info = vi.fn();
    const logger = { info };

    recordClientVersionObservation({ version: "0.1.29", remoteAddress: "10.0.0.5", logger });
    recordClientVersionObservation({ version: "0.1.29", remoteAddress: "10.0.0.5", logger });
    recordClientVersionObservation({ version: "0.1.29", remoteAddress: "10.0.0.6", logger });
    recordClientVersionObservation({ version: "0.1.28", remoteAddress: "10.0.0.5", logger });

    expect(info).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenCalledWith(
      { clientVersion: "0.1.29", remoteAddress: "10.0.0.5" },
      "Desktop client version observed",
    );

    const snapshot = snapshotClientVersionObservations()
      .map(({ version, remoteAddress, requests }) => ({ version, remoteAddress, requests }))
      .sort((a, b) => `${a.version}|${a.remoteAddress}`.localeCompare(`${b.version}|${b.remoteAddress}`));
    expect(snapshot).toEqual([
      { version: "0.1.28", remoteAddress: "10.0.0.5", requests: 1 },
      { version: "0.1.29", remoteAddress: "10.0.0.5", requests: 2 },
      { version: "0.1.29", remoteAddress: "10.0.0.6", requests: 1 },
    ]);
  });

  it("ignores absent, empty, and oversized headers", () => {
    const logger = { info: vi.fn() };
    recordClientVersionObservation({ version: undefined, remoteAddress: "10.0.0.5", logger });
    recordClientVersionObservation({ version: "", remoteAddress: "10.0.0.5", logger });
    recordClientVersionObservation({ version: "x".repeat(65), remoteAddress: "10.0.0.5", logger });
    recordClientVersionObservation({ version: ["0.1.29"], remoteAddress: "10.0.0.5", logger });

    expect(logger.info).not.toHaveBeenCalled();
    expect(snapshotClientVersionObservations()).toEqual([]);
  });
});
