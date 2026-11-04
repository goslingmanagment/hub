import { useQuery } from "@tanstack/react-query";
import type { Platform } from "@agency_hub_core/shared";
import { useOverview } from "@/api/queries";
import { kernel } from "@/api/sdk";
import { useOfapiStatus } from "@/api/waiting";
import { syncStatusWord } from "@/components/shared/syncUxDisplay";
import { enginePageStatus } from "@/pages/settings/engine/enginePageSummary";
import { engineStatusState } from "@/pages/settings/engine/engineDisplay";
import { collectionWord, COLLECTION_STATUS, type StatusWord } from "@/lib/statusWords";

const MINUTE = 60_000;

export interface PageCollection {
  /** Null: still reading, a skeleton. Absent from the view (a team lead on OnlyFans): `hidden`. */
  word: StatusWord | null;
  hidden: boolean;
  /** Which of the six: `login`, `attention`, `ofapiOff`, … for the header's notice. */
  kind: "working" | "login" | "attention" | "lagging" | "paused" | "ofapiOff" | "notNeeded" | "moving" | "unknown" | "loading";
  /** Why, in Russian, the server's own facts. */
  reason: string | null;
}

type Page = { id: number; label: string; platform: Platform };

function kindOfWord(word: StatusWord | null): PageCollection["kind"] {
  if (word === null) return "loading";
  if (word === COLLECTION_STATUS.requiresAction) return "login";
  if (word === COLLECTION_STATUS.attention) return "attention";
  if (word === COLLECTION_STATUS.delayed || word === COLLECTION_STATUS.retrying) return "lagging";
  if (word === COLLECTION_STATUS.paused) return "paused";
  if (word === COLLECTION_STATUS.ofapiOff) return "ofapiOff";
  if (word === COLLECTION_STATUS.notNeeded) return "notNeeded";
  if (word === COLLECTION_STATUS.setup || word === COLLECTION_STATUS.catching_up) return "moving";
  if (word === COLLECTION_STATUS.unknown) return "unknown";
  return "working";
}

/**
 * How the page is collected, in one of six words (design/screens/fans-page.md §9.2).
 * The owner's Fansly word is the same function that counts «Нужен вход» on Главная,
 * so the header and the home never disagree. Re-read once a minute while visible.
 */
export function usePageCollection(page: Page, role: "owner" | "team_lead"): PageCollection {
  const owner = role === "owner";
  const ofapi = useOfapiStatus(role);
  const ownerFansly = owner && page.platform === "fansly";
  const blocks = useQuery({
    queryKey: ["syncBlocks", "page", page.label],
    queryFn: () => kernel.pageSyncBlocks({ params: { pageLabel: page.label } }),
    enabled: ownerFansly,
    refetchInterval: MINUTE,
    meta: { suppressGlobalError: true },
  });
  const engine = useQuery({
    queryKey: ["syncEngine", "pages"],
    queryFn: () => kernel.syncPages(),
    enabled: ownerFansly,
    refetchInterval: MINUTE,
    meta: { suppressGlobalError: true },
  });
  const needsOverview = (!owner && page.platform === "fansly") || (owner && page.platform === "onlyfans" && ofapi === "on");
  const overview = useOverview();
  const syncUx = needsOverview ? overview.data?.pages.find((item) => item.id === page.id)?.syncUx : undefined;

  if (page.platform === "telegram") {
    return { word: collectionWord({ platform: "telegram" }), hidden: false, kind: "notNeeded", reason: null };
  }
  if (page.platform === "onlyfans") {
    if (!owner) return { word: null, hidden: true, kind: "unknown", reason: null };
    if (ofapi !== "on") {
      const word = collectionWord({ platform: "onlyfans", ofapi });
      return { word, hidden: false, kind: kindOfWord(word), reason: null };
    }
    if (!syncUx) return overview.isError ? { word: COLLECTION_STATUS.unknown, hidden: false, kind: "unknown", reason: null } : { word: null, hidden: false, kind: "loading", reason: null };
    // Without the platform: with it the function calls any failure «switched off».
    const word = syncStatusWord(syncUx);
    return { word, hidden: false, kind: kindOfWord(word), reason: null };
  }
  if (!owner) {
    if (!syncUx) return overview.isError ? { word: COLLECTION_STATUS.unknown, hidden: false, kind: "unknown", reason: null } : { word: null, hidden: false, kind: "loading", reason: null };
    const word = syncStatusWord(syncUx, "fansly");
    return { word, hidden: false, kind: kindOfWord(word), reason: null };
  }
  if (!blocks.data) {
    return blocks.isError ? { word: COLLECTION_STATUS.unknown, hidden: false, kind: "unknown", reason: null } : { word: null, hidden: false, kind: "loading", reason: null };
  }
  const status = engine.data?.pages.find((item) => item?.pageLabel === page.label);
  const state = engine.isError ? { kind: "error" as const } : engine.data === undefined ? { kind: "loading" as const } : engineStatusState(status);
  const result = enginePageStatus(blocks.data.page, state as Parameters<typeof enginePageStatus>[1]);
  const word = collectionWord({ platform: "fansly", kind: result.kind });
  return { word, hidden: false, kind: kindOfWord(word), reason: result.reason };
}
