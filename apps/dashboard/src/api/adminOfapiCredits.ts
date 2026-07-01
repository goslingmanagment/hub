import { useQuery } from "@tanstack/react-query";
import type {
  OfapiCreditsDailyResponse,
  OfapiCreditsLedgerResponse,
  OfapiCreditsSummaryResponse,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";

export function useAdminOfapiCreditsSummary() {
  return useQuery({
    queryKey: ["admin", "ofapi-credits", "summary"],
    queryFn: () => api.get<OfapiCreditsSummaryResponse>("/api/v1/admin/ofapi/credits/summary"),
    refetchInterval: 60_000,
  });
}

export function useAdminOfapiCreditsDaily(days: number) {
  return useQuery({
    queryKey: ["admin", "ofapi-credits", "daily", days],
    queryFn: () => api.get<OfapiCreditsDailyResponse>(`/api/v1/admin/ofapi/credits/daily${qs({ days })}`),
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

export function useAdminOfapiCreditsLedger(params: AdminOfapiCreditsLedgerParams) {
  return useQuery({
    queryKey: ["admin", "ofapi-credits", "ledger", params],
    queryFn: () => api.get<OfapiCreditsLedgerResponse>(`/api/v1/admin/ofapi/credits/ledger${qs({ ...params })}`),
  });
}

export interface OfapiCreditsLedgerCsvParams {
  source?: string;
  pageId?: number;
  operation?: string;
  from?: string;
  to?: string;
}

export function ofapiCreditsLedgerCsvUrl(params: OfapiCreditsLedgerCsvParams) {
  return `/api/v1/admin/ofapi/credits/ledger.csv${qs({ ...params })}`;
}

export interface OfapiCreditsLedgerCsvResult {
  rowCount: number;
  // True when the export hit the server's row cap and is therefore incomplete.
  truncated: boolean;
}

/**
 * Streams the filtered ledger as a CSV download. The shared `api` client always
 * JSON-parses, so this goes through a raw cookie-authenticated fetch → blob →
 * temporary anchor, which keeps the SPA's session cookie and honours the
 * server's Content-Disposition filename. Returns the server's row count and
 * truncation flag so the caller can warn when a capped extract is incomplete.
 */
export async function downloadOfapiCreditsLedgerCsv(
  params: OfapiCreditsLedgerCsvParams,
): Promise<OfapiCreditsLedgerCsvResult> {
  const response = await fetch(ofapiCreditsLedgerCsvUrl(params), { credentials: "include" });
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
