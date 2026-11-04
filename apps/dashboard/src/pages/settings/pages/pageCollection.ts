import type { AssignedPage, ConnectionItem, SyncBlocksPage } from "@agency_hub_core/contracts";
import { syncStatusWord } from "@/components/shared/syncUxDisplay";
import { formatDateTime, formatMomentAgo } from "@/lib/format";
import { COLLECTION_STATUS, collectionWord, type OfapiStatus, type StatusWord } from "@/lib/statusWords";
import type { EngineStatusState } from "../engine/engineDisplay.js";
import { enginePageStatus } from "../engine/enginePageSummary.js";

/**
 * A page's collection in the catalog's column «Сбор данных»: the one word of
 * `collectionWord`, the same reads and the same calculation as «Ждут вас» and
 * «Система → Сбор данных» (design/screens/settings.md §1.3). Only reads.
 */
export interface PageCollection {
  /** Null: still loading, a skeleton is drawn. */
  word: StatusWord | null;
  /** The second line, in words. */
  detail: string | null;
  /** The exact moment behind «обновлено …», for the title. */
  detailTitle?: string | undefined;
  /** The one button the row shows: a login, or the page's collection screen. */
  action: "login" | "collection" | null;
  /** The engine's kind of a Fansly page: `login` raises the notice over the catalog. */
  kind: string | null;
}

export interface CollectionReads {
  overview: { pages: readonly SyncBlocksPage[] } | undefined;
  overviewFailed: boolean;
  engineStatusOf: (pageLabel: string) => EngineStatusState;
  connection: ConnectionItem | undefined;
  connectionsFailed: boolean;
  ofapi: OfapiStatus;
  ofapiLoading: boolean;
}

function updatedLine(at: string | null): { text: string; title: string } | null {
  if (!at) return null;
  const moment = formatMomentAgo(at);
  // «обновлено в 23:23, 18 мин назад» today, «обновлено 3 нояб., 14:05, 2 дня назад» before.
  const today = /^\d{2}:\d{2},/.test(moment);
  return { text: `обновлено ${today ? "в " : ""}${moment}`, title: formatDateTime(at, { yearUnlessCurrent: true }) };
}

const NOT_LOADED = "состояние сбора не загрузилось";

export function pageCollection(page: AssignedPage, reads: CollectionReads): PageCollection {
  if (page.platform === "telegram") {
    return { word: collectionWord({ platform: "telegram" }), detail: "Hub не собирает данные Telegram", action: null, kind: null };
  }

  if (page.platform === "onlyfans") {
    if (reads.ofapi === "unknown" && reads.ofapiLoading) return { word: null, detail: null, action: null, kind: null };
    if (reads.ofapi === "off") {
      return { word: COLLECTION_STATUS.ofapiOff, detail: "Доход и переписка идут из ленты ChatSpace", action: null, kind: null };
    }
    if (reads.ofapi === "unknown") {
      return { word: COLLECTION_STATUS.unknown, detail: "не удалось проверить OnlyFans API", action: null, kind: null };
    }
    if (!reads.connection) {
      if (!reads.connectionsFailed) return { word: null, detail: null, action: null, kind: null };
      return { word: COLLECTION_STATUS.unknown, detail: NOT_LOADED, action: null, kind: null };
    }
    const updated = updatedLine(page.lastLightSyncAt);
    return {
      word: syncStatusWord(reads.connection.syncUx, "onlyfans", reads.ofapi),
      detail: updated?.text ?? null,
      detailTitle: updated?.title,
      action: null,
      kind: null,
    };
  }

  // Fansly: the engine's word, as on «Сбор данных».
  if (!reads.overview) {
    if (!reads.overviewFailed) return { word: null, detail: null, action: null, kind: null };
    return { word: COLLECTION_STATUS.unknown, detail: NOT_LOADED, action: null, kind: "unknown" };
  }
  const blocks = reads.overview.pages.find((candidate) => candidate.pageLabel === page.label);
  if (!blocks) return { word: COLLECTION_STATUS.unknown, detail: NOT_LOADED, action: null, kind: "unknown" };
  const status = enginePageStatus(blocks, reads.engineStatusOf(page.label));
  const word = collectionWord({ platform: "fansly", kind: status.kind });
  if (word === null) return { word: null, detail: null, action: null, kind: status.kind };

  if (status.kind === "working") {
    const updated = updatedLine(page.lastLightSyncAt);
    const paused = status.reason?.startsWith("на паузе") ? status.reason : null;
    return {
      word,
      detail: [updated?.text, paused].filter(Boolean).join(" · ") || null,
      detailTitle: updated?.title,
      action: null,
      kind: status.kind,
    };
  }
  return {
    word,
    detail: status.reason,
    action: status.kind === "login" ? "login" : status.kind === "proxy" || status.kind === "off" ? "collection" : null,
    kind: status.kind,
  };
}
