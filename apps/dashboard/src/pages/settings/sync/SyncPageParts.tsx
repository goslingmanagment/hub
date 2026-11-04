// What the collection screens share of a page: its one status line, as
// `enginePageStatus` (Fansly) and `syncPageStatus` (OnlyFans) answer it. The word
// on screen comes from `collectionWord` (lib/statusWords.ts) by `kind`.

export type PageStatusTone = "success" | "warning" | "danger" | "info" | "neutral";

/** A page in one line: what it is (`kind`) and why, in a few words. */
export interface PageStatus {
  kind: string;
  label: string;
  tone: PageStatusTone;
  reason: string | null;
}
