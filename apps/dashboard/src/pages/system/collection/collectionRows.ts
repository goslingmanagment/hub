import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { collectionWord, COLLECTION_STATUS, type OfapiStatus, type StatusWord } from "@/lib/statusWords";
import type { EngineStatusState } from "@/pages/settings/engine/engineDisplay";
import { enginePageStatus } from "@/pages/settings/engine/enginePageSummary";
import { syncPageStatus } from "@/pages/settings/sync/syncBlockDisplay";

/** A page's collection in a row: the one word, the second line and what the row may offer. */
export interface CollectionRow {
  page: SyncBlocksPage;
  /** Null: still loading. */
  word: StatusWord | null;
  second: string | null;
  /** «Войти в Fansly» is the way out. */
  login: boolean;
  /** The latest data of any block of the page. */
  lastAt: string | null;
  rank: number;
}

/** The order of the table: what needs the owner first (design/screens/system.md §2). */
const RANK: ReadonlyArray<StatusWord> = [
  COLLECTION_STATUS.requiresAction,
  COLLECTION_STATUS.attention,
  COLLECTION_STATUS.delayed,
  COLLECTION_STATUS.unknown,
  COLLECTION_STATUS.setup,
  COLLECTION_STATUS.catching_up,
  COLLECTION_STATUS.healthy,
  COLLECTION_STATUS.paused,
  COLLECTION_STATUS.ofapiOff,
  COLLECTION_STATUS.notNeeded,
];

function rankOf(word: StatusWord | null): number {
  if (word === null) return RANK.length;
  const index = RANK.findIndex((entry) => entry.word === word.word);
  return index < 0 ? RANK.length : index;
}

export function lastDataAt(page: SyncBlocksPage): string | null {
  let latest: string | null = null;
  for (const block of Object.values(page.blocks)) {
    if (block.succeededAt !== null && (latest === null || block.succeededAt > latest)) latest = block.succeededAt;
  }
  return latest;
}

const ONLYFANS_SECOND: Readonly<Record<string, string>> = {
  login: "доступ через OnlyFans API больше не действует",
  paused: "все блоки на паузе",
  not_started: "данных пока нет",
};

/** The word and the second line of a page by its platform (design/screens/system.md §0.3). */
export function collectionRow(page: SyncBlocksPage, engine: EngineStatusState, ofapi: OfapiStatus, now: number = Date.now()): CollectionRow {
  const lastAt = lastDataAt(page);
  if (page.platform === "telegram") {
    return { page, word: COLLECTION_STATUS.notNeeded, second: "Hub не собирает данные Telegram", login: false, lastAt: null, rank: rankOf(COLLECTION_STATUS.notNeeded) };
  }
  if (page.platform === "onlyfans") {
    const status = syncPageStatus(page);
    const word = collectionWord({ platform: "onlyfans", ofapi, kind: status.kind });
    const second = ofapi === "off"
      ? "Доход и переписка идут из ленты ChatSpace"
      : ofapi === "unknown"
        ? "не удалось проверить OnlyFans API"
        : ONLYFANS_SECOND[status.kind] ?? status.reason;
    return { page, word, second, login: false, lastAt, rank: rankOf(word) };
  }
  const status = enginePageStatus(page, engine, now);
  const word = collectionWord({ platform: "fansly", kind: status.kind });
  return { page, word, second: status.reason, login: status.kind === "login", lastAt, rank: rankOf(word) };
}

export function sortRows(rows: CollectionRow[]): CollectionRow[] {
  // Within a word, the server's order.
  return rows.map((row, index) => ({ row, index })).sort((a, b) => a.row.rank - b.row.rank || a.index - b.index).map(({ row }) => row);
}
