import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

export function useAdminOfapiCreditsSummary() {
  return useQuery({
    queryKey: ["admin", "ofapi-credits", "summary"],
    queryFn: () => kernel.adminOfapiCreditsSummary(),
    refetchInterval: 60_000,
  });
}

export function useAdminOfapiSpendComparison(params: { days: number; sampleLimit: number }) {
  return useQuery({
    queryKey: ["admin", "ofapi-spend-comparison", params],
    queryFn: () => kernel.adminOfapiSpendComparison({ query: params }),
  });
}

export function useAdminOfapiCreditsDaily(days: number) {
  return useQuery({
    queryKey: ["admin", "ofapi-credits", "daily", days],
    queryFn: () => kernel.adminOfapiCreditsDaily({ query: { days } }),
  });
}

export interface AdminOfapiCreditsLedgerParams {
  offset: number;
  limit: number;
  source?: string;
  pageId?: number;
  operation?: string;
  from?: string;
  to?: string;
}

export function useAdminOfapiCreditsLedger(params: AdminOfapiCreditsLedgerParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "ofapi-credits", "ledger", params],
    enabled: options.enabled ?? true,
    queryFn: () => kernel.adminOfapiCreditsLedger({
      query: params as Parameters<typeof kernel.adminOfapiCreditsLedger>[0]["query"],
    }),
  });
}

export interface OfapiCreditsLedgerCsvParams {
  source?: string;
  pageId?: number;
  operation?: string;
  from?: string;
  to?: string;
}

export interface OfapiCreditsLedgerCsvResult {
  rowCount: number;
  // True when the export hit the server's row cap and is therefore incomplete.
  truncated: boolean;
}

/**
 * Streams the filtered ledger as a CSV download through the SDK's raw()
 * escape hatch (the CSV export is on the SDK exclusion list — no JSON, no
 * validation), then hands the blob to a temporary anchor, honouring the
 * server's Content-Disposition filename. Returns the server's row count and
 * truncation flag so the caller can warn when a capped extract is incomplete.
 */
export async function downloadOfapiCreditsLedgerCsv(
  params: OfapiCreditsLedgerCsvParams,
): Promise<OfapiCreditsLedgerCsvResult> {
  const response = await kernel.raw("adminOfapiCreditsLedgerCsv", {
    query: params as Record<string, unknown>,
  });
  if (!response.ok) {
    throw new Error(`Export failed (HTTP ${response.status})`);
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? "ofapi-credit-ledger.csv";

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  return {
    rowCount: Number(response.headers.get("x-export-row-count") ?? "0"),
    truncated: response.headers.get("x-export-truncated") === "1",
  };
}
