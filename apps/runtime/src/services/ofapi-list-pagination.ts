import { OFAPI_DEFAULT_BASE_URL, OfapiApiError, type OfapiListPage } from "./ofapi.ts";

/** Extract only a verified offset; never follow a provider URL as transport. */
export function resolveOfapiListNextOffset(
  page: Pick<OfapiListPage, "hasNextPage" | "nextPageUrl">,
  input: { pathname: string; offset: number; limit: number; baseUrl?: string | undefined },
): number | null {
  if (!page.nextPageUrl) return page.hasNextPage ? input.offset + input.limit : null;
  const base = new URL(`${input.baseUrl ?? OFAPI_DEFAULT_BASE_URL}/`);
  const expected = `${base.pathname.replace(/\/$/, "")}${input.pathname}`;
  let next: URL;
  try { next = new URL(page.nextPageUrl, base); }
  catch { throw new OfapiApiError("OFAPI list pagination invalid", 200, null); }
  const offset = next.searchParams.get("offset");
  if (next.origin !== base.origin || next.pathname !== expected || next.username || next.password || next.hash ||
      next.searchParams.getAll("offset").length !== 1 || !offset || !/^\d+$/.test(offset) ||
      !Number.isSafeInteger(Number(offset)) || Number(offset) <= input.offset ||
      [...next.searchParams.keys()].some(key => !["limit", "offset"].includes(key)) ||
      next.searchParams.getAll("limit").length > 1 ||
      (next.searchParams.has("limit") && next.searchParams.get("limit") !== String(input.limit))) {
    throw new OfapiApiError("OFAPI list pagination invalid or not advancing", 200, null);
  }
  return Number(offset);
}
