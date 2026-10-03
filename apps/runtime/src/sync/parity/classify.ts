import type { DmParityFullRow, DmParityRefState } from "@agency_hub_core/db";
import { millsToWholeCents, normalizeDmMessageText } from "@agency_hub_core/shared";

// Step 4, S4-06 (owner decision №11): the pure part of the DM reader parity.
// A reader is called twice on the same snapshot — on page_dm_messages and on
// the message_archive variant S4-08 serves from — and every difference is
// classified here:
//   missing_in_archive  the archive variant lacks what the hot one shows (a
//                       row, a REST copy, a deletion); FAILS only when it
//                       persists: still missing at a recheck ≥ 2 min after it
//                       was first seen (the archive trails page_dm_messages by
//                       its projection minute);
//   field_mismatch      both show a message (or a thread value) differently;
//                       fails;
//   extra_in_archive    the archive knows more (a row the hot table lacks, the
//                       September sidecar rows, a deletion first); expected,
//                       reported for the owner;
//   tie_order           the same messages in a different order; informational.
// A message one window shows and the other does not, while the other store
// does hold it, is a window shift (another row's difference pushed it out) and
// is only counted.

export const PARITY_CLASSES = ["missing_in_archive", "field_mismatch", "extra_in_archive", "tie_order"] as const;
export type ParityClass = (typeof PARITY_CLASSES)[number];

export const PARITY_READERS = [
  "A1.messages@25",
  "A1.messages@100",
  "A2.preview@25",
  "A2.coverage",
  "A3.transcript",
  "A4.summary",
  "B.storedFacts",
  "B.windowSummary",
  "full",
] as const;
export type ParityReader = (typeof PARITY_READERS)[number];

/** A missing message must still be missing this long after it was first
 *  seen to fail (design S4-06: two rounds ≥ 2 min apart). */
export const PARITY_PERSISTENCE_MS = 120_000;

export type ParityValue = string | number | boolean | null;

/** One message as a reader shows it, reduced to what is compared. */
export interface ParityMessage {
  id: string;
  /** `rest` (a store row) or `live` (an overlay row); null without an overlay. */
  provenance: "rest" | "live" | null;
  /** A tombstone the reader returns (the transcript keeps them). */
  deleted: boolean;
  fields: Record<string, ParityValue>;
}

/** A difference, before it is placed (page, chat, reader). `messageId` null
 *  is a thread value (a summary column, the coverage). `aspect` names the
 *  field of a mismatch, or what is missing or extra: `row`, `rest_copy`,
 *  `deletion`, `thread`; `order` for a tie. */
export interface ParityFinding {
  class: ParityClass;
  messageId: string | null;
  aspect: string;
  hot: ParityValue;
  archive: ParityValue;
}

/** The instant a reader serves, to the second (design S4-06). */
export function toSecond(value: Date | null): string | null {
  return value === null ? null : `${value.toISOString().slice(0, 19)}Z`;
}

/** The text a reader serves, normalized (the API normalizes either store). */
export function servedText(value: string | null | undefined): string {
  return normalizeDmMessageText(value ?? "");
}

/** What the presence of one message in each store means, when only one
 *  store holds it live (or a window shows it from one side only). */
export function presenceFinding(state: DmParityRefState, conversationRef: string): ParityFinding | null {
  const id = state.ref;
  if (state.hot === "other_conversation" || state.archive === "other_conversation") {
    const hotChat = state.hot === "other_conversation" ? state.hotConversationRef : state.hot === "absent" ? null : conversationRef;
    const archiveChat = state.archive === "other_conversation"
      ? state.archiveConversationRef
      : state.archive === "absent" ? null : conversationRef;
    if (hotChat === archiveChat) return null;
    return { class: "field_mismatch", messageId: id, aspect: "conversation", hot: hotChat, archive: archiveChat };
  }
  const missing = (aspect: string): ParityFinding => ({
    class: "missing_in_archive", messageId: id, aspect, hot: state.hot, archive: state.archive,
  });
  const extra = (aspect: string): ParityFinding => ({
    class: "extra_in_archive", messageId: id, aspect, hot: state.hot, archive: state.archive,
  });
  const hotLive = state.hot === "live";
  const archiveLive = state.archive === "live";
  if (hotLive && archiveLive) return null;
  if (hotLive) return state.archive === "deleted" ? extra("deletion") : missing("row");
  if (archiveLive) return state.hot === "deleted" ? missing("deletion") : extra("row");
  // Neither holds it live: only the overlay can show it, and only where the
  // reader's store does not hold the message at all.
  if (state.hot === "deleted" && (state.archive === "absent" || state.archive === "not_stored")) return missing("row");
  if (state.hot === "absent" && state.archive === "deleted") return extra("deletion");
  return null;
}

/** The ids one window shows and the other does not (their states classify them). */
export function oneSidedIds(hot: readonly ParityMessage[], archive: readonly ParityMessage[]): string[] {
  const hotIds = new Set(hot.map((message) => message.id));
  const archiveIds = new Set(archive.map((message) => message.id));
  return [
    ...hot.filter((message) => !archiveIds.has(message.id)).map((message) => message.id),
    ...archive.filter((message) => !hotIds.has(message.id)).map((message) => message.id),
  ];
}

/**
 * Compare one reader's window from both stores. `states` must hold every id
 * of `oneSidedIds(hot, archive)` (read in the same snapshot).
 */
export function compareMessageWindows(
  hot: readonly ParityMessage[],
  archive: readonly ParityMessage[],
  states: ReadonlyMap<string, DmParityRefState>,
  conversationRef: string,
): { findings: ParityFinding[]; shifted: number } {
  const findings: ParityFinding[] = [];
  let shifted = 0;
  const archiveById = new Map(archive.map((message) => [message.id, message]));
  const hotIds = new Set(hot.map((message) => message.id));
  const oneSided = (id: string) => {
    const state = states.get(id);
    if (state === undefined) throw new Error(`No store state for message ${id}`);
    const finding = presenceFinding(state, conversationRef);
    if (finding === null) shifted += 1;
    else findings.push(finding);
  };
  for (const message of hot) {
    const twin = archiveById.get(message.id);
    if (twin === undefined) {
      oneSided(message.id);
      continue;
    }
    if (message.provenance !== twin.provenance) {
      // A REST copy one store holds and the other does not: the other shows
      // the socket's copy (or nothing). The fields differ by construction.
      findings.push({
        class: message.provenance === "rest" ? "missing_in_archive" : "extra_in_archive",
        messageId: message.id,
        aspect: "rest_copy",
        hot: message.provenance,
        archive: twin.provenance,
      });
      continue;
    }
    if (message.deleted !== twin.deleted) {
      findings.push({
        class: message.deleted ? "missing_in_archive" : "extra_in_archive",
        messageId: message.id,
        aspect: "deletion",
        hot: message.deleted ? "deleted" : "live",
        archive: twin.deleted ? "deleted" : "live",
      });
    }
    for (const field of new Set([...Object.keys(message.fields), ...Object.keys(twin.fields)])) {
      const left = message.fields[field] ?? null;
      const right = twin.fields[field] ?? null;
      if (left !== right) {
        findings.push({ class: "field_mismatch", messageId: message.id, aspect: field, hot: left, archive: right });
      }
    }
  }
  for (const message of archive) {
    if (!hotIds.has(message.id)) oneSided(message.id);
  }
  const hotOrder = hot.filter((message) => archiveById.has(message.id)).map((message) => message.id);
  const archiveOrder = archive.filter((message) => hotIds.has(message.id)).map((message) => message.id);
  hotOrder.forEach((id, index) => {
    if (archiveOrder[index] !== id) {
      findings.push({ class: "tie_order", messageId: id, aspect: "order", hot: index, archive: archiveOrder.indexOf(id) });
    }
  });
  return { findings, shifted };
}

/** The fields of two thread values (a summary, the stored facts) that differ. */
export function differingFields(
  hot: Record<string, ParityValue>,
  archive: Record<string, ParityValue>,
): Array<{ field: string; hot: ParityValue; archive: ParityValue }> {
  const differing: Array<{ field: string; hot: ParityValue; archive: ParityValue }> = [];
  for (const field of new Set([...Object.keys(hot), ...Object.keys(archive)])) {
    const left = hot[field] ?? null;
    const right = archive[field] ?? null;
    if (left !== right) differing.push({ field, hot: left, archive: right });
  }
  return differing;
}

/** The `--full` judgement of one hot row against the archive row with its
 *  message id: presence first, then (both live) the fields the readers serve. */
export function compareFullRow(row: DmParityFullRow): ParityFinding[] {
  const archive = row.archive;
  const state: DmParityRefState = {
    ref: row.ref,
    hot: row.hot.deleted ? "deleted" : "live",
    archive: archive === null
      ? "absent"
      : archive.conversationRef !== row.conversationRef
        ? "other_conversation"
        : archive.deleted ? "deleted" : archive.stored ? "live" : "not_stored",
    hotConversationRef: null,
    archiveConversationRef: archive !== null && archive.conversationRef !== row.conversationRef ? archive.conversationRef : null,
  };
  const presence = presenceFinding(state, row.conversationRef);
  if (presence !== null) return [presence];
  if (archive === null || state.hot !== "live" || state.archive !== "live") return [];
  const hotOpened = row.hot.opened;
  return differingFields({
    senderRole: row.hot.senderRole,
    senderId: row.hot.senderId,
    text: servedText(row.hot.content),
    createdAt: toSecond(row.hot.createdAt),
    tipCents: row.hot.tipCents,
    // The transcript upgrades PPV from the hot purchase; the archive must
    // carry it as opened.
    isOpened: hotOpened ? true : null,
  }, {
    senderRole: archive.senderRole,
    senderId: archive.senderId,
    text: servedText(archive.textPlain),
    createdAt: toSecond(archive.occurredAt),
    tipCents: millsToWholeCents(archive.tipMills),
    isOpened: hotOpened ? archive.isOpened === true : null,
  }).map((difference) => ({
    class: "field_mismatch" as const,
    messageId: row.ref,
    aspect: difference.field,
    hot: difference.hot,
    archive: difference.archive,
  }));
}

// ── the ledger ────────────────────────────────────────────────────────────────

export type MissingStatus = "open" | "persistent" | "resolved";

/** Where a finding was seen. */
export interface ParityPlace {
  pageId: number;
  pageLabel: string;
  threadId: number | null;
  conversationRef: string;
  reader: ParityReader;
}

export interface ParityItem {
  class: ParityClass;
  pageId: number;
  pageLabel: string;
  threadId: number | null;
  conversationRef: string;
  messageId: string | null;
  aspect: string;
  hot: ParityValue;
  archive: ParityValue;
  readers: ParityReader[];
  firstSeenAt: string;
  lastSeenAt: string;
  observations: number;
  /** missing_in_archive only. */
  status: MissingStatus | null;
  /** When a recheck or a later observation ≥ 2 min on decided it. */
  decidedAt: string | null;
}

/** A summary column that differs from the rows of BOTH stores alike (the
 *  engine's incremental bookkeeping, `sync chain check-window`'s drift):
 *  not a store difference; S4-08's 0236 recomputes it. Informational. */
export interface SummaryDriftItem {
  pageId: number;
  pageLabel: string;
  threadId: number | null;
  conversationRef: string;
  reader: ParityReader;
  field: string;
  column: ParityValue;
  rows: ParityValue;
}

export interface ParityClassReport {
  total: number;
  byReader: Partial<Record<ParityReader, number>>;
  byPage: Record<string, number>;
  /** missing_in_archive only. */
  persistent?: number;
  resolved?: number;
  open?: number;
  /** field_mismatch only. */
  byField?: Record<string, number>;
  items: ParityItem[];
  itemsTruncated: boolean;
}

/** At most this many items of one class are listed in the report (the
 *  counts are always whole). */
export const PARITY_ITEMS_LISTED = 5_000;

function itemKey(item: Pick<ParityItem, "class" | "pageId" | "conversationRef" | "messageId" | "aspect">): string {
  return JSON.stringify([item.class, item.pageId, item.conversationRef, item.messageId, item.aspect]);
}

export class ParityLedger {
  readonly #items = new Map<string, ParityItem>();
  readonly #drift = new Map<string, SummaryDriftItem>();
  readonly #shifts: Partial<Record<ParityReader, number>> = {};

  record(place: ParityPlace, finding: ParityFinding, at: Date): void {
    const key = itemKey({ ...finding, pageId: place.pageId, conversationRef: place.conversationRef });
    const known = this.#items.get(key);
    if (known === undefined) {
      this.#items.set(key, {
        class: finding.class,
        pageId: place.pageId,
        pageLabel: place.pageLabel,
        threadId: place.threadId,
        conversationRef: place.conversationRef,
        messageId: finding.messageId,
        aspect: finding.aspect,
        hot: finding.hot,
        archive: finding.archive,
        readers: [place.reader],
        firstSeenAt: at.toISOString(),
        lastSeenAt: at.toISOString(),
        observations: 1,
        status: finding.class === "missing_in_archive" ? "open" : null,
        decidedAt: null,
      });
      return;
    }
    if (!known.readers.includes(place.reader)) known.readers.push(place.reader);
    known.threadId ??= place.threadId;
    known.lastSeenAt = at.toISOString();
    known.observations += 1;
    if (known.class !== "missing_in_archive") return;
    if (known.status === "resolved") {
      // Seen again after a recheck found it: a new episode.
      known.status = "open";
      known.firstSeenAt = at.toISOString();
      known.decidedAt = null;
    } else if (known.status === "open" && at.getTime() - Date.parse(known.firstSeenAt) >= PARITY_PERSISTENCE_MS) {
      known.status = "persistent";
      known.decidedAt = at.toISOString();
    }
  }

  recordDrift(place: ParityPlace, field: string, column: ParityValue, rows: ParityValue): void {
    const key = JSON.stringify([place.pageId, place.conversationRef, place.reader, field]);
    this.#drift.set(key, {
      pageId: place.pageId,
      pageLabel: place.pageLabel,
      threadId: place.threadId,
      conversationRef: place.conversationRef,
      reader: place.reader,
      field,
      column,
      rows,
    });
  }

  recordShift(reader: ParityReader, count: number): void {
    if (count > 0) this.#shifts[reader] = (this.#shifts[reader] ?? 0) + count;
  }

  /** Open missing items first seen ≥ 2 min before `at`: due for a recheck. */
  dueRechecks(at: Date): ParityItem[] {
    return this.openMissing().filter((item) => at.getTime() - Date.parse(item.firstSeenAt) >= PARITY_PERSISTENCE_MS);
  }

  openMissing(): ParityItem[] {
    return [...this.#items.values()].filter((item) => item.class === "missing_in_archive" && item.status === "open");
  }

  /** A recheck's answer: still missing (persistent) or not (resolved). */
  decide(item: ParityItem, stillMissing: boolean, at: Date): void {
    item.status = stillMissing ? "persistent" : "resolved";
    item.decidedAt = at.toISOString();
  }

  items(): ParityItem[] {
    return [...this.#items.values()];
  }

  classes(): Record<ParityClass, ParityClassReport> {
    const report = {} as Record<ParityClass, ParityClassReport>;
    for (const parityClass of PARITY_CLASSES) {
      const items = this.items().filter((item) => item.class === parityClass);
      const byReader: Partial<Record<ParityReader, number>> = {};
      const byPage: Record<string, number> = {};
      for (const item of items) {
        for (const reader of item.readers) byReader[reader] = (byReader[reader] ?? 0) + 1;
        byPage[item.pageLabel] = (byPage[item.pageLabel] ?? 0) + 1;
      }
      const entry: ParityClassReport = {
        total: items.length,
        byReader,
        byPage,
        items: items.slice(0, PARITY_ITEMS_LISTED),
        itemsTruncated: items.length > PARITY_ITEMS_LISTED,
      };
      if (parityClass === "missing_in_archive") {
        entry.persistent = items.filter((item) => item.status === "persistent").length;
        entry.resolved = items.filter((item) => item.status === "resolved").length;
        entry.open = items.filter((item) => item.status === "open").length;
      }
      if (parityClass === "field_mismatch") {
        const byField: Record<string, number> = {};
        for (const item of items) byField[item.aspect] = (byField[item.aspect] ?? 0) + 1;
        entry.byField = byField;
      }
      report[parityClass] = entry;
    }
    return report;
  }

  drift(): SummaryDriftItem[] {
    return [...this.#drift.values()];
  }

  shifts(): Partial<Record<ParityReader, number>> {
    return { ...this.#shifts };
  }
}

/** The extra_in_archive rows by thread: the list the owner gets (№11). */
export interface ExtraThread {
  pageLabel: string;
  threadId: number | null;
  conversationRef: string;
  messages: number;
  /** Of them, how many each reader window showed. */
  byReader: Partial<Record<ParityReader, number>>;
}

export function extraThreads(items: readonly ParityItem[]): ExtraThread[] {
  const threads = new Map<string, ExtraThread>();
  for (const item of items) {
    if (item.class !== "extra_in_archive" || item.messageId === null) continue;
    const key = JSON.stringify([item.pageId, item.conversationRef]);
    const thread = threads.get(key) ?? {
      pageLabel: item.pageLabel,
      threadId: item.threadId,
      conversationRef: item.conversationRef,
      messages: 0,
      byReader: {},
    };
    thread.messages += 1;
    for (const reader of item.readers) thread.byReader[reader] = (thread.byReader[reader] ?? 0) + 1;
    threads.set(key, thread);
  }
  return [...threads.values()].sort((a, b) => b.messages - a.messages || a.conversationRef.localeCompare(b.conversationRef));
}

/** Pass (design S4-06): 0 persistent missing_in_archive and 0 field_mismatch
 *  (the `--full` scan's included), nothing left unconfirmed, and `--full`
 *  done over every Fansly hot row when it was asked for. */
export function parityVerdict(input: {
  classes: Record<ParityClass, ParityClassReport>;
  fullRequested: boolean;
  fullCompleted: boolean;
}): { verdict: "pass" | "fail"; failReasons: string[] } {
  const failReasons: string[] = [];
  const missing = input.classes.missing_in_archive;
  if ((missing.persistent ?? 0) > 0) failReasons.push(`${missing.persistent} persistent missing_in_archive`);
  if ((missing.open ?? 0) > 0) failReasons.push(`${missing.open} missing_in_archive never rechecked`);
  if (input.classes.field_mismatch.total > 0) failReasons.push(`${input.classes.field_mismatch.total} field_mismatch`);
  if (input.fullRequested && !input.fullCompleted) failReasons.push("--full did not finish");
  return { verdict: failReasons.length === 0 ? "pass" : "fail", failReasons };
}
