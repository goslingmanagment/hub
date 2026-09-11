import type { UsagePeriod } from "./format.js";

export function resolveUsageSearch(search: URLSearchParams, today: string) {
  const requestedMode = search.get("mode");
  const mode: UsagePeriod = requestedMode === "week" || requestedMode === "month" ? requestedMode : "day";
  const requestedDate = search.get("date");
  const parsed = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
    ? new Date(`${requestedDate}T12:00:00Z`) : null;
  const validDate = parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === requestedDate;
  const anchor = validDate && requestedDate! <= today ? requestedDate! : today;
  return {
    mode, anchor, search: search.get("q") ?? "",
    corrected: (requestedMode !== null && !["day", "week", "month"].includes(requestedMode))
      || (requestedDate !== null && anchor !== requestedDate),
  };
}
