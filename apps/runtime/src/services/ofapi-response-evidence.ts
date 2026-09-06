import { asRecord } from "./ofapi-payloads.ts";

type HeaderInput = Headers | Record<string, string>;
const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Fresh response headers take precedence over cached body metadata. A cache/replay flag alone
 * never proves a credit amount or command success. Both sources stay in the durable response. */
export function ofapiResponseEvidence(body: unknown, headers?: HeaderInput) {
  const root = asRecord(body);
  const meta = asRecord(root?._meta) ?? (asRecord(root?._credits) ? root : null);
  const credits = asRecord(meta?._credits);
  const get = (name: string): string | null => {
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get(name);
    return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
  };
  const headerNumber = (name: string) => {
    const value = get(name);
    return value !== null && /^\d+$/.test(value) ? number(Number(value)) : null;
  };
  const bodyUsed = number(credits?.used);
  const bodyBalance = number(credits?.balance);
  const headerUsed = headerNumber("x-ofapi-credits-used");
  const headerBalance = headerNumber("x-ofapi-credits-balance");
  const cached = get("x-ofapi-is-cached");
  const cache = asRecord(meta?._cache);
  const rates = asRecord(meta?._rate_limits);
  const isCached = cached === "true" || cached === "1" ? true : cached === "false" || cached === "0" ? false
    : typeof cache?.is_cached === "boolean" ? cache.is_cached : null;
  return {
    meta: {
      creditsUsed: headerUsed ?? bodyUsed, creditBalance: headerBalance ?? bodyBalance, isCached,
      rateRemainingMinute: headerNumber("x-rate-limit-remaining-minute") ?? number(rates?.remaining_minute),
    },
    evidence: { bodyUsed, bodyBalance, headerUsed, headerBalance,
      conflict: (headerUsed !== null && bodyUsed !== null && headerUsed !== bodyUsed)
        || (headerBalance !== null && bodyBalance !== null && headerBalance !== bodyBalance),
      replayed: get("idempotent-replayed") === "true", precedence: "response_headers" as const },
    present: meta !== null || headerUsed !== null || headerBalance !== null || cached !== null,
  };
}
