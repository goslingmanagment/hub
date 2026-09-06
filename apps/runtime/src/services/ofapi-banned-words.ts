import { createHash } from "node:crypto";
import { getOfapiBannedDictionary, saveOfapiBannedDictionary, type OfapiBannedDictionary, type OfapiBannedWord } from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { asRecord } from "./ofapi-payloads.ts";
export function previewOfapiBannedWords(text: string, dictionary: OfapiBannedDictionary | null) {
  const matches: Array<OfapiBannedWord & { start: number; end: number }> = [];
  for (const entry of dictionary?.entries ?? []) {
    // Escape every metacharacter: provider regex_pattern is deliberately never read or executed.
    const escaped = entry.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "giu");
    for (const match of text.matchAll(pattern)) {
      matches.push({ ...entry, start: match.index, end: match.index + match[0].length });
      if (matches.length >= 100) break;
    }
    if (matches.length >= 100) break;
  }
  return { version: dictionary?.version ?? null, observedAt: dictionary?.observedAt ?? null, complete: dictionary?.complete ?? false, matching: "literal_case_insensitive" as const, matches };
}
export async function refreshOfapiBannedWords(app: AppContext, maxPages: number) {
  if (!app.ofapi?.getBannedWordsPage) throw new ServiceUnavailableError("OFAPI dictionary client unavailable");
  const entries: OfapiBannedWord[] = []; const observationIds: number[] = []; let complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const response = await app.ofapi.getBannedWordsPage(page);
    const root = asRecord(response.body); const meta = asRecord(root?.meta);
    if (!response.evidence || !Array.isArray(root?.data) || root.data.length > 100 || meta?.current_page !== page || !Number.isInteger(meta?.last_page)) throw new ServiceUnavailableError("Banned-word response shape or capture unavailable");
    observationIds.push(response.evidence.observationId);
    for (const raw of root.data) {
      const entry = asRecord(raw);
      if (!entry || typeof entry.word !== "string" || !entry.word.trim() || entry.word.length > 500 || typeof entry.risk_level !== "string") throw new ServiceUnavailableError("Banned-word entry is malformed");
      entries.push({ word: entry.word, riskLevel: entry.risk_level, category: typeof entry.category === "string" ? entry.category : null, alternatives: typeof entry.safe_alternatives === "string" ? entry.safe_alternatives : null });
    }
    if (page >= Number(meta?.last_page)) { complete = true; break; }
    if (!root.data.length) throw new ServiceUnavailableError("Banned-word pagination did not advance");
  }
  const dictionary = { version: createHash("sha256").update(JSON.stringify({ entries, complete })).digest("hex"), observedAt: new Date().toISOString(), complete, pages: observationIds.length, entries };
  await saveOfapiBannedDictionary(app.db, { ...dictionary, observationId: observationIds[0]!, observationIds });
  return dictionary;
}
export async function getOfapiBannedWordsPreview(app: AppContext, text: string) { return previewOfapiBannedWords(text, await getOfapiBannedDictionary(app.db)); }
