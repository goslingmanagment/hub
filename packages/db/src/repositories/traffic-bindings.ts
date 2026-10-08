import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { TrafficLinkKind, TrafficValidFromBasis } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { insertAuditEvent } from "./auth.ts";

// OnlyFans traffic sources (plan 2026-10-08, PR 11; tables 0255): "link →
// channel → contractor" with dates, written only by the owner's CLI.
//
// The invariant: at any instant a link has at most one channel and a channel
// at most one contractor — closed rows included. The open-row unique indexes
// cannot see two closed intervals, so every write here (П9.6):
//   1. takes a transaction advisory lock on each key it touches — the link
//      key (page × kind × link id) for a binding, the channel key for a
//      channel → contractor term, the contractor key for a contractor —
//      in ascending lock-id order, so two writers never deadlock;
//   2. only then reads every row of those keys, open and closed;
//   3. plans the change and checks the resulting rows of each key for
//      overlaps; any conflict aborts before the first write;
//   4. writes, one audit_events row per change, and commits.
// A second writer of the same key waits at step 1 and, at step 2 (a new
// READ COMMITTED snapshot), sees the first one's rows.
//
// A file row matches an existing row when key, target (the contractor or the
// channel) and valid_from are equal. A match may close an open row (set
// valid_to) and change basis or note; a closed row is never reopened or
// moved. Every other file row is a new row. Rows the file does not name are
// left as they are: an import adds and closes, it does not replace a key's
// history.

const TRAFFIC_BINDINGS_LOCK_SEED = 625_301_108;

export const TRAFFIC_BINDINGS_AUDIT_SOURCE = "cli";

export interface TrafficContractorInput {
  key: string;
  title: string;
}

export interface TrafficChannelInput {
  key: string;
  title: string;
  /** undefined: keep the stored note; null: clear it. */
  note?: string | null;
}

export interface TrafficChannelTermInput {
  channelKey: string;
  contractorKey: string;
  validFrom: Date;
  validTo: Date | null;
  validFromBasis: TrafficValidFromBasis;
  note?: string | null;
}

export interface TrafficLinkBindingInput {
  pageLabel: string;
  linkKind: TrafficLinkKind;
  linkId: string;
  channelKey: string;
  validFrom: Date;
  validTo: Date | null;
  validFromBasis: TrafficValidFromBasis;
  note?: string | null;
}

export interface TrafficBindingsChangeSet {
  contractors: TrafficContractorInput[];
  channels: TrafficChannelInput[];
  terms: TrafficChannelTermInput[];
  bindings: TrafficLinkBindingInput[];
}

/** One interval row of a key (a channel's term or a link's binding). */
export interface TrafficIntervalRow {
  id: number;
  /** The contractor key of a term, the channel key of a binding. */
  target: string;
  validFrom: Date;
  validTo: Date | null;
  validFromBasis: TrafficValidFromBasis;
  note: string | null;
}

export interface TrafficIntervalDesired {
  target: string;
  validFrom: Date;
  validTo: Date | null;
  validFromBasis: TrafficValidFromBasis;
  note?: string | null;
}

export type TrafficIntervalAction =
  | { action: "create"; row: Omit<TrafficIntervalRow, "id"> }
  | { action: "close" | "update"; id: number; before: TrafficIntervalRow; after: TrafficIntervalRow }
  | { action: "unchanged"; id: number; row: TrafficIntervalRow };

export interface TrafficIntervalPlan {
  actions: TrafficIntervalAction[];
  conflicts: string[];
}

const iso = (value: Date | null) => (value === null ? null : value.toISOString());
const sameInstant = (a: Date | null, b: Date | null) =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

function describeInterval(row: { target: string; validFrom: Date; validTo: Date | null }) {
  return `${row.target} [${row.validFrom.toISOString()}, ${row.validTo === null ? "open" : row.validTo.toISOString()})`;
}

function overlaps(a: { validFrom: Date; validTo: Date | null }, b: { validFrom: Date; validTo: Date | null }) {
  const aEnd = a.validTo === null ? Number.POSITIVE_INFINITY : a.validTo.getTime();
  const bEnd = b.validTo === null ? Number.POSITIVE_INFINITY : b.validTo.getTime();
  return a.validFrom.getTime() < bEnd && b.validFrom.getTime() < aEnd;
}

/**
 * The change of one key's history (pure; the caller holds the key's lock and
 * passed every stored row of the key). Conflicts: a duplicate file row, an
 * empty interval, a closed row the file would reopen or move, and any two
 * resulting rows that overlap — open or closed.
 */
export function planTrafficIntervals(
  keyLabel: string,
  existing: readonly TrafficIntervalRow[],
  desired: readonly TrafficIntervalDesired[],
): TrafficIntervalPlan {
  const conflicts: string[] = [];
  const actions: TrafficIntervalAction[] = [];
  const seen = new Set<string>();

  for (const want of desired) {
    if (want.validTo !== null && want.validTo.getTime() <= want.validFrom.getTime()) {
      conflicts.push(`${keyLabel}: ${describeInterval(want)} ends before it starts`);
      continue;
    }
    const identity = `${want.target}@${want.validFrom.getTime()}`;
    if (seen.has(identity)) {
      conflicts.push(`${keyLabel}: ${want.target} from ${want.validFrom.toISOString()} is named twice`);
      continue;
    }
    seen.add(identity);
    const stored = existing.find((row) => row.target === want.target && sameInstant(row.validFrom, want.validFrom));
    if (!stored) {
      actions.push({
        action: "create",
        row: {
          target: want.target,
          validFrom: want.validFrom,
          validTo: want.validTo,
          validFromBasis: want.validFromBasis,
          note: want.note ?? null,
        },
      });
      continue;
    }
    let validTo = stored.validTo;
    if (!sameInstant(stored.validTo, want.validTo)) {
      if (stored.validTo !== null) {
        conflicts.push(
          `${keyLabel}: ${describeInterval(stored)} is closed; an import does not reopen or move it `
            + `(the file says ${want.validTo === null ? "open" : want.validTo.toISOString()})`,
        );
        continue;
      }
      validTo = want.validTo;
    }
    const after: TrafficIntervalRow = {
      ...stored,
      validTo,
      validFromBasis: want.validFromBasis,
      note: want.note === undefined ? stored.note : want.note,
    };
    const changed = !sameInstant(after.validTo, stored.validTo)
      || after.validFromBasis !== stored.validFromBasis
      || after.note !== stored.note;
    if (!changed) {
      actions.push({ action: "unchanged", id: stored.id, row: stored });
    } else {
      actions.push({
        action: sameInstant(after.validTo, stored.validTo) ? "update" : "close",
        id: stored.id,
        before: stored,
        after,
      });
    }
  }

  // The rows of the key once the plan is applied: every stored row (updated
  // where the plan changes it) and every new one.
  const result: Array<{ target: string; validFrom: Date; validTo: Date | null }> = [];
  for (const row of existing) {
    const change = actions.find((action) => action.action !== "create" && action.id === row.id);
    result.push(change && (change.action === "close" || change.action === "update") ? change.after : row);
  }
  for (const action of actions) {
    if (action.action === "create") result.push(action.row);
  }
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      if (overlaps(result[i]!, result[j]!)) {
        conflicts.push(`${keyLabel}: ${describeInterval(result[i]!)} overlaps ${describeInterval(result[j]!)}`);
      }
    }
  }
  return { actions, conflicts };
}

export class TrafficBindingsConflictError extends Error {
  constructor(readonly conflicts: string[]) {
    super(`traffic bindings: ${conflicts.length} conflict(s), nothing written:\n- ${conflicts.join("\n- ")}`);
    this.name = "TrafficBindingsConflictError";
  }
}

const linkKeyLabel = (key: { pageLabel: string; linkKind: string; linkId: string }) =>
  `${key.pageLabel} ${key.linkKind} ${key.linkId}`;
const linkLockKey = (key: { pageId: number; linkKind: string; linkId: string }) =>
  `traffic-link:${key.pageId}:${key.linkKind}:${key.linkId}`;
const channelLockKey = (channelKey: string) => `traffic-channel:${channelKey}`;
const contractorLockKey = (contractorKey: string) => `traffic-contractor:${contractorKey}`;

/** Transaction advisory locks on the keys, in ascending lock-id order (two
 *  writers with overlapping key sets never wait on each other in a cycle). */
async function lockTrafficKeys(tx: Database, keys: readonly string[]) {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;
  const ids = await tx.execute<{ lock_id: string }>(sql`
    select distinct hashtextextended(k, ${TRAFFIC_BINDINGS_LOCK_SEED})::text as lock_id
      from unnest(array[${sql.join(unique.map((k) => sql`${k}`), sql`, `)}]::text[]) as k
  `);
  const sorted = ids.rows.map((row) => BigInt(row.lock_id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of sorted) {
    await tx.execute(sql`select pg_advisory_xact_lock(${id.toString()}::bigint)`);
  }
}

interface PageRow {
  id: number;
  label: string;
  platform: string;
  status: string;
  /** An active OnlyFans page: the only pages whose links are bound. */
  bindable: boolean;
}

async function resolvePages(db: Database, labels: readonly string[]) {
  const unique = [...new Set(labels)];
  const found = new Map<string, PageRow>();
  if (unique.length === 0) return found;
  const result = await db.execute<{ id: string; label: string; platform: string; status: string; bindable: boolean }>(sql`
    select id::text as id, label, platform::text as platform, status::text as status,
           (platform = 'onlyfans' and status = 'active') as bindable
      from pages where label in (${sql.join(unique.map((label) => sql`${label}`), sql`, `)})
  `);
  for (const row of result.rows) found.set(row.label, { ...row, id: Number(row.id) });
  return found;
}

interface StoredContractor { id: number; key: string; title: string }
interface StoredChannel { id: number; key: string; title: string; note: string | null }

async function readContractors(db: Database, keys: readonly string[]) {
  const map = new Map<string, StoredContractor>();
  if (keys.length === 0) return map;
  const result = await db.execute<{ id: string; key: string; title: string }>(sql`
    select id::text as id, key, title from traffic_contractors
     where key in (${sql.join([...new Set(keys)].map((key) => sql`${key}`), sql`, `)})
  `);
  for (const row of result.rows) map.set(row.key, { id: Number(row.id), key: row.key, title: row.title });
  return map;
}

async function readChannels(db: Database, keys: readonly string[]) {
  const map = new Map<string, StoredChannel>();
  if (keys.length === 0) return map;
  const result = await db.execute<{ id: string; key: string; title: string; note: string | null }>(sql`
    select id::text as id, key, title, note from traffic_channels
     where key in (${sql.join([...new Set(keys)].map((key) => sql`${key}`), sql`, `)})
  `);
  for (const row of result.rows) map.set(row.key, { id: Number(row.id), key: row.key, title: row.title, note: row.note });
  return map;
}

interface StoredIntervalRow extends Record<string, unknown> {
  id: string;
  target: string;
  valid_from: Date;
  valid_to: Date | null;
  valid_from_basis: TrafficValidFromBasis;
  note: string | null;
}

const toIntervalRow = (row: StoredIntervalRow): TrafficIntervalRow => ({
  id: Number(row.id),
  target: row.target,
  validFrom: new Date(row.valid_from),
  validTo: row.valid_to === null ? null : new Date(row.valid_to),
  validFromBasis: row.valid_from_basis,
  note: row.note,
});

async function readChannelTerms(db: Database, channelKey: string) {
  const result = await db.execute<StoredIntervalRow>(sql`
    select t.id::text as id, k.key as target, t.valid_from, t.valid_to, t.valid_from_basis, t.note
      from traffic_channel_contractors t
      join traffic_channels c on c.id = t.channel_id
      join traffic_contractors k on k.id = t.contractor_id
     where c.key = ${channelKey}
     order by t.valid_from, t.id
  `);
  return result.rows.map(toIntervalRow);
}

async function readLinkBindings(db: Database, key: { pageId: number; linkKind: string; linkId: string }) {
  const result = await db.execute<StoredIntervalRow>(sql`
    select b.id::text as id, c.key as target, b.valid_from, b.valid_to, b.valid_from_basis, b.note
      from traffic_link_bindings b
      join traffic_channels c on c.id = b.channel_id
     where b.platform_account_id = ${key.pageId} and b.link_kind = ${key.linkKind}
       and b.platform_link_id = ${key.linkId}
     order by b.valid_from, b.id
  `);
  return result.rows.map(toIntervalRow);
}

export type TrafficEntityAction = "create" | "update" | "unchanged";

export interface TrafficContractorChange {
  action: TrafficEntityAction;
  key: string;
  before: { title: string } | null;
  after: { title: string };
}

export interface TrafficChannelChange {
  action: TrafficEntityAction;
  key: string;
  before: { title: string; note: string | null } | null;
  after: { title: string; note: string | null };
}

export interface TrafficChannelTermChange {
  channelKey: string;
  change: TrafficIntervalAction;
}

export interface TrafficLinkBindingChange {
  link: { pageLabel: string; linkKind: TrafficLinkKind; linkId: string };
  change: TrafficIntervalAction;
}

export interface TrafficBindingsPlan {
  contractors: TrafficContractorChange[];
  channels: TrafficChannelChange[];
  terms: TrafficChannelTermChange[];
  bindings: TrafficLinkBindingChange[];
  conflicts: string[];
  /** Facts worth a look that do not stop the import. */
  warnings: string[];
}

export interface TrafficBindingsApplyOptions {
  /** false: plan only, inside a read-only transaction. */
  write: boolean;
  /** Who runs it, for the audit rows (e.g. `cli@host pid 123`). */
  actor: string;
  command: "import" | "set";
  /** Extra audit metadata, e.g. the file name and its SHA-256. */
  auditContext?: Record<string, unknown>;
  /** Tests: called with the page labels resolved, before the keys are locked. */
  afterResolve?: () => Promise<void>;
  /** Tests: called with the keys locked and the plan checked, before the first write. */
  afterPlan?: () => Promise<void>;
}

export interface TrafficBindingsApplyResult {
  written: boolean;
  batchId: string;
  plan: TrafficBindingsPlan;
  auditEventIds: number[];
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** `pages`: the operation's one label → page mapping (the keys were locked under it). */
async function buildPlan(db: Database, change: TrafficBindingsChangeSet, pages: Map<string, PageRow>): Promise<{
  plan: TrafficBindingsPlan;
  pages: Map<string, PageRow>;
}> {
  const conflicts: string[] = [];
  const warnings: string[] = [];

  const duplicates = <T>(items: readonly T[], keyOf: (item: T) => string, what: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      const key = keyOf(item);
      if (seen.has(key)) conflicts.push(`${what} ${key} is named twice`);
      seen.add(key);
    }
  };
  duplicates(change.contractors, (c) => c.key, "contractor");
  duplicates(change.channels, (c) => c.key, "channel");

  const contractorKeys = [...change.contractors.map((c) => c.key), ...change.terms.map((t) => t.contractorKey)];
  const channelKeys = [
    ...change.channels.map((c) => c.key),
    ...change.terms.map((t) => t.channelKey),
    ...change.bindings.map((b) => b.channelKey),
  ];
  const storedContractors = await readContractors(db, contractorKeys);
  const storedChannels = await readChannels(db, channelKeys);

  const contractors: TrafficContractorChange[] = change.contractors.map((wanted) => {
    const stored = storedContractors.get(wanted.key);
    if (!stored) return { action: "create", key: wanted.key, before: null, after: { title: wanted.title } };
    return {
      action: stored.title === wanted.title ? "unchanged" : "update",
      key: wanted.key,
      before: { title: stored.title },
      after: { title: wanted.title },
    };
  });
  const channels: TrafficChannelChange[] = change.channels.map((wanted) => {
    const stored = storedChannels.get(wanted.key);
    if (!stored) {
      return { action: "create", key: wanted.key, before: null, after: { title: wanted.title, note: wanted.note ?? null } };
    }
    const after = { title: wanted.title, note: wanted.note === undefined ? stored.note : wanted.note };
    return {
      action: after.title === stored.title && after.note === stored.note ? "unchanged" : "update",
      key: wanted.key,
      before: { title: stored.title, note: stored.note },
      after,
    };
  });

  const knownContractors = new Set([...storedContractors.keys(), ...change.contractors.map((c) => c.key)]);
  const knownChannels = new Set([...storedChannels.keys(), ...change.channels.map((c) => c.key)]);

  const terms: TrafficChannelTermChange[] = [];
  for (const [channelKey, wanted] of groupBy(change.terms, (t) => t.channelKey)) {
    if (!knownChannels.has(channelKey)) {
      conflicts.push(`channel ${channelKey}: unknown channel (not in the file, not stored)`);
      continue;
    }
    const unknown = wanted.filter((t) => !knownContractors.has(t.contractorKey));
    for (const term of unknown) {
      conflicts.push(`channel ${channelKey}: unknown contractor ${term.contractorKey} (not in the file, not stored)`);
    }
    if (unknown.length > 0) continue;
    const existing = storedChannels.has(channelKey) ? await readChannelTerms(db, channelKey) : [];
    const plan = planTrafficIntervals(
      `channel ${channelKey}`,
      existing,
      wanted.map((t) => ({
        target: t.contractorKey,
        validFrom: t.validFrom,
        validTo: t.validTo,
        validFromBasis: t.validFromBasis,
        ...(t.note === undefined ? {} : { note: t.note }),
      })),
    );
    conflicts.push(...plan.conflicts);
    for (const action of plan.actions) terms.push({ channelKey, change: action });
  }

  const bindings: TrafficLinkBindingChange[] = [];
  for (const [, wanted] of groupBy(change.bindings, (b) => `${b.pageLabel}\u0000${b.linkKind}\u0000${b.linkId}`)) {
    const first = wanted[0]!;
    const label = `link ${linkKeyLabel(first)}`;
    const page = pages.get(first.pageLabel);
    if (!page) {
      conflicts.push(`${label}: unknown page ${first.pageLabel}`);
      continue;
    }
    if (!page.bindable) {
      conflicts.push(`${label}: page ${first.pageLabel} is ${page.platform}/${page.status}, not an active OnlyFans page`);
      continue;
    }
    const unknown = wanted.filter((b) => !knownChannels.has(b.channelKey));
    for (const binding of unknown) {
      conflicts.push(`${label}: unknown channel ${binding.channelKey} (not in the file, not stored)`);
    }
    if (unknown.length > 0) continue;
    const existing = await readLinkBindings(db, { pageId: page.id, linkKind: first.linkKind, linkId: first.linkId });
    const plan = planTrafficIntervals(
      label,
      existing,
      wanted.map((b) => ({
        target: b.channelKey,
        validFrom: b.validFrom,
        validTo: b.validTo,
        validFromBasis: b.validFromBasis,
        ...(b.note === undefined ? {} : { note: b.note }),
      })),
    );
    conflicts.push(...plan.conflicts);
    for (const action of plan.actions) {
      bindings.push({ link: { pageLabel: first.pageLabel, linkKind: first.linkKind, linkId: first.linkId }, change: action });
    }
  }

  // What the link series knows of each link: unseen links and assumed starts
  // that are not the series' creation date are worth a look, not a refusal
  // (a link the coordinator just created is not in the series yet).
  const created = await readSeriesLinkCreation(db, change.bindings.flatMap((b) => {
    const page = pages.get(b.pageLabel);
    return page ? [{ pageId: page.id, linkKind: b.linkKind, linkId: b.linkId }] : [];
  }));
  for (const binding of change.bindings) {
    const page = pages.get(binding.pageLabel);
    if (!page) continue;
    const key = `${page.id}:${binding.linkKind}:${binding.linkId}`;
    if (!created.has(key)) {
      warnings.push(`link ${linkKeyLabel(binding)}: not seen in the link series (page_link_stat_snapshots)`);
      continue;
    }
    const linkCreatedAt = created.get(key) ?? null;
    if (
      binding.validFromBasis === "assumed_link_created"
      && linkCreatedAt !== null
      && linkCreatedAt.getTime() !== binding.validFrom.getTime()
    ) {
      warnings.push(
        `link ${linkKeyLabel(binding)}: assumed_link_created from ${binding.validFrom.toISOString()}, `
          + `the series says the link was created ${linkCreatedAt.toISOString()}`,
      );
    }
  }

  return { plan: { contractors, channels, terms, bindings, conflicts, warnings }, pages };
}

/** The newest link_created_at the series has for each link (null: seen, date unknown). */
async function readSeriesLinkCreation(db: Database, links: Array<{ pageId: number; linkKind: string; linkId: string }>) {
  const created = new Map<string, Date | null>();
  if (links.length === 0) return created;
  const result = await db.execute<{ page_id: string; link_kind: string; link_id: string; link_created_at: Date | null }>(sql`
    select distinct on (s.platform_account_id, s.link_kind, s.platform_link_id)
           s.platform_account_id::text as page_id, s.link_kind, s.platform_link_id as link_id, s.link_created_at
      from page_link_stat_snapshots s
     where (s.platform_account_id, s.link_kind, s.platform_link_id) in (
       ${sql.join(links.map((l) => sql`(${l.pageId}::bigint, ${l.linkKind}::text, ${l.linkId}::text)`), sql`, `)})
     order by s.platform_account_id, s.link_kind, s.platform_link_id, s.id desc
  `);
  for (const row of result.rows) {
    created.set(
      `${row.page_id}:${row.link_kind}:${row.link_id}`,
      row.link_created_at === null ? null : new Date(row.link_created_at),
    );
  }
  return created;
}

function lockKeysOf(change: TrafficBindingsChangeSet, pages: Map<string, PageRow>) {
  const keys: string[] = [];
  for (const contractor of change.contractors) keys.push(contractorLockKey(contractor.key));
  for (const term of change.terms) keys.push(contractorLockKey(term.contractorKey), channelLockKey(term.channelKey));
  for (const channel of change.channels) keys.push(channelLockKey(channel.key));
  for (const binding of change.bindings) {
    const page = pages.get(binding.pageLabel);
    if (page) keys.push(linkLockKey({ pageId: page.id, linkKind: binding.linkKind, linkId: binding.linkId }));
  }
  return keys;
}

function expectOneRow(rows: readonly unknown[], what: string) {
  if (rows.length !== 1) throw new Error(`traffic bindings: ${what} wrote ${rows.length} rows, expected 1`);
}

const intervalAudit = (row: Omit<TrafficIntervalRow, "id"> | TrafficIntervalRow) => ({
  target: row.target,
  validFrom: iso(row.validFrom),
  validTo: iso(row.validTo),
  validFromBasis: row.validFromBasis,
  note: row.note,
});

async function writePlan(
  tx: Database,
  plan: TrafficBindingsPlan,
  pages: Map<string, PageRow>,
  options: TrafficBindingsApplyOptions,
  batchId: string,
) {
  const auditEventIds: number[] = [];
  const audit = async (eventType: string, metadata: Record<string, unknown>, platformAccountId: number | null = null) => {
    const event = await insertAuditEvent(tx, {
      platformAccountId,
      source: TRAFFIC_BINDINGS_AUDIT_SOURCE,
      eventType,
      metadata: { actor: options.actor, command: options.command, batchId, ...options.auditContext, ...metadata },
    });
    if (event) auditEventIds.push(Number(event.id));
  };

  for (const contractor of plan.contractors) {
    if (contractor.action === "create") {
      await tx.execute(sql`insert into traffic_contractors (key, title) values (${contractor.key}, ${contractor.after.title})`);
      await audit("admin.traffic_contractor_created", { key: contractor.key, after: contractor.after });
    } else if (contractor.action === "update") {
      await tx.execute(sql`
        update traffic_contractors set title = ${contractor.after.title}, updated_at = now() where key = ${contractor.key}`);
      await audit("admin.traffic_contractor_updated", { key: contractor.key, before: contractor.before, after: contractor.after });
    }
  }
  for (const channel of plan.channels) {
    if (channel.action === "create") {
      await tx.execute(sql`
        insert into traffic_channels (key, title, note) values (${channel.key}, ${channel.after.title}, ${channel.after.note})`);
      await audit("admin.traffic_channel_created", { key: channel.key, after: channel.after });
    } else if (channel.action === "update") {
      await tx.execute(sql`
        update traffic_channels set title = ${channel.after.title}, note = ${channel.after.note}, updated_at = now()
         where key = ${channel.key}`);
      await audit("admin.traffic_channel_updated", { key: channel.key, before: channel.before, after: channel.after });
    }
  }

  // Closes and updates before creates: a re-hang closes the open row before
  // the new open row lands (the open-row unique index sees one at a time).
  const ordered = <T extends { change: TrafficIntervalAction }>(items: readonly T[]) => [
    ...items.filter((item) => item.change.action === "close" || item.change.action === "update"),
    ...items.filter((item) => item.change.action === "create"),
  ];

  for (const term of ordered(plan.terms)) {
    const change = term.change;
    if (change.action === "create") {
      await tx.execute(sql`
        insert into traffic_channel_contractors (channel_id, contractor_id, valid_from, valid_to, valid_from_basis, note)
        select c.id, k.id, ${change.row.validFrom}, ${change.row.validTo}, ${change.row.validFromBasis}, ${change.row.note}
          from traffic_channels c, traffic_contractors k
         where c.key = ${term.channelKey} and k.key = ${change.row.target}
        returning id`).then((result) => expectOneRow(result.rows, `channel ${term.channelKey} → ${change.row.target}`));
      await audit("admin.traffic_channel_contractor_created", { channelKey: term.channelKey, after: intervalAudit(change.row) });
    } else if (change.action === "close" || change.action === "update") {
      await tx.execute(sql`
        update traffic_channel_contractors
           set valid_to = ${change.after.validTo}, valid_from_basis = ${change.after.validFromBasis},
               note = ${change.after.note}, updated_at = now()
         where id = ${change.id}`);
      await audit(`admin.traffic_channel_contractor_${change.action === "close" ? "closed" : "updated"}`, {
        channelKey: term.channelKey,
        rowId: change.id,
        before: intervalAudit(change.before),
        after: intervalAudit(change.after),
      });
    }
  }

  for (const binding of ordered(plan.bindings)) {
    const change = binding.change;
    const page = pages.get(binding.link.pageLabel)!;
    const link = { pageLabel: page.label, linkKind: binding.link.linkKind, linkId: binding.link.linkId };
    if (change.action === "create") {
      await tx.execute(sql`
        insert into traffic_link_bindings
          (platform_account_id, link_kind, platform_link_id, channel_id, valid_from, valid_to, valid_from_basis, note)
        select ${page.id}, ${link.linkKind}, ${link.linkId}, c.id, ${change.row.validFrom}, ${change.row.validTo},
               ${change.row.validFromBasis}, ${change.row.note}
          from traffic_channels c where c.key = ${change.row.target}
        returning id`).then((result) => expectOneRow(result.rows, `link ${linkKeyLabel(link)} → ${change.row.target}`));
      await audit("admin.traffic_link_binding_created", { link, after: intervalAudit(change.row) }, page.id);
    } else if (change.action === "close" || change.action === "update") {
      await tx.execute(sql`
        update traffic_link_bindings
           set valid_to = ${change.after.validTo}, valid_from_basis = ${change.after.validFromBasis},
               note = ${change.after.note}, updated_at = now()
         where id = ${change.id}`);
      await audit(`admin.traffic_link_binding_${change.action === "close" ? "closed" : "updated"}`, {
        link,
        rowId: change.id,
        before: intervalAudit(change.before),
        after: intervalAudit(change.after),
      }, page.id);
    }
  }
  return auditEventIds;
}

/**
 * The one transaction shape of every write: a dry run plans in a read-only
 * transaction (nothing locked, nothing written); a write takes the keys'
 * advisory locks first, derives the change and plans it over every stored row
 * of those keys — all read under the locks — and throws
 * TrafficBindingsConflictError before the first write if anything conflicts.
 */
interface DerivedTrafficChange {
  change: TrafficBindingsChangeSet;
  /** Conflicts the derivation itself found (e.g. a `set` that would move a stored start). */
  conflicts: string[];
}

async function planDerived(database: Database, derived: DerivedTrafficChange, pages: Map<string, PageRow>) {
  const built = await buildPlan(database, derived.change, pages);
  built.plan.conflicts.unshift(...derived.conflicts);
  return built;
}

/** The labels whose page is no longer the one the operation resolved (relabelled meanwhile). */
async function relabelledPages(database: Database, pages: Map<string, PageRow>, labels: readonly string[]) {
  const now = await resolvePages(database, labels);
  const conflicts: string[] = [];
  for (const label of new Set(labels)) {
    const before = pages.get(label)?.id ?? null;
    const after = now.get(label)?.id ?? null;
    if (before !== after) {
      conflicts.push(
        `page ${label}: was page ${before ?? "none"} when the operation started, is page ${after ?? "none"} `
          + "once its locks are held (relabelled meanwhile); nothing written — run it again",
      );
    }
  }
  return conflicts;
}

async function runTrafficChange(
  db: Database,
  options: TrafficBindingsApplyOptions,
  labels: readonly string[],
  keysOf: (pages: Map<string, PageRow>) => string[],
  changeOf: (tx: Database, pages: Map<string, PageRow>) => Promise<DerivedTrafficChange>,
): Promise<TrafficBindingsApplyResult> {
  const batchId = randomUUID();
  if (!options.write) {
    return db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const pages = await resolvePages(database, labels);
      const { plan } = await planDerived(database, await changeOf(database, pages), pages);
      return { written: false, batchId, plan, auditEventIds: [] };
    }, { accessMode: "read only" });
  }
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    // One label → page mapping per operation: the link keys are locked, the
    // plan is made and the rows are written under it. A label that names
    // another page once the locks are held (relabelled while waiting) would
    // put rows under a key this transaction does not hold: refuse.
    const pages = await resolvePages(database, labels);
    await options.afterResolve?.();
    await lockTrafficKeys(database, keysOf(pages));
    const relabelled = await relabelledPages(database, pages, labels);
    if (relabelled.length > 0) throw new TrafficBindingsConflictError(relabelled);
    const built = await planDerived(database, await changeOf(database, pages), pages);
    if (built.plan.conflicts.length > 0) throw new TrafficBindingsConflictError(built.plan.conflicts);
    await options.afterPlan?.();
    const auditEventIds = await writePlan(database, built.plan, built.pages, options, batchId);
    return { written: true, batchId, plan: built.plan, auditEventIds };
  }, { isolationLevel: "read committed" });
}

/** Plan a change of the bindings and, with `write`, apply it — all or nothing (runTrafficChange). */
export async function applyTrafficBindingsChange(
  db: Database,
  change: TrafficBindingsChangeSet,
  options: TrafficBindingsApplyOptions,
): Promise<TrafficBindingsApplyResult> {
  return runTrafficChange(
    db,
    options,
    change.bindings.map((b) => b.pageLabel),
    (pages) => lockKeysOf(change, pages),
    async () => ({ change, conflicts: [] }),
  );
}

export interface TrafficLinkRehangInput {
  pageLabel: string;
  linkKind: TrafficLinkKind;
  linkId: string;
  channelKey: string;
  validFrom: Date;
  validFromBasis: TrafficValidFromBasis;
  note?: string | null;
}

/**
 * `traffic:bindings:set`: from `validFrom` the link is the channel's. The
 * link's open binding to another channel is closed at `validFrom`. An open
 * binding to the same channel that started at or before `validFrom` already
 * says so (a no-op); one that started later is a conflict — the earlier
 * stretch would silently stay with whoever had it before, and moving a stored
 * start is not what `set` does. Same lock, plan and audit as an import (the
 * open row is read under the link's lock).
 */
export async function rehangTrafficLink(
  db: Database,
  input: TrafficLinkRehangInput,
  options: Omit<TrafficBindingsApplyOptions, "command">,
): Promise<TrafficBindingsApplyResult> {
  const derive = async (database: Database, pages: Map<string, PageRow>): Promise<DerivedTrafficChange> => {
    const page = pages.get(input.pageLabel);
    const existing = page
      ? await readLinkBindings(database, { pageId: page.id, linkKind: input.linkKind, linkId: input.linkId })
      : [];
    const open = existing.find((row) => row.validTo === null);
    const common = { pageLabel: input.pageLabel, linkKind: input.linkKind, linkId: input.linkId };
    if (open && open.target === input.channelKey) {
      // Already the channel's: name the open row as it is (a no-op) — or
      // refuse, when the requested start lies before the stored one.
      const unchanged: TrafficBindingsChangeSet = {
        contractors: [], channels: [], terms: [],
        bindings: [{ ...common, channelKey: open.target, validFrom: open.validFrom, validTo: null, validFromBasis: open.validFromBasis }],
      };
      if (input.validFrom.getTime() < open.validFrom.getTime()) {
        return {
          change: unchanged,
          conflicts: [
            `link ${linkKeyLabel(common)}: already ${open.target} only since ${open.validFrom.toISOString()}; `
              + `--from ${input.validFrom.toISOString()} is earlier — set does not move a stored start`,
          ],
        };
      }
      return { change: unchanged, conflicts: [] };
    }
    const bindings: TrafficLinkBindingInput[] = [];
    if (open) {
      bindings.push({
        ...common,
        channelKey: open.target,
        validFrom: open.validFrom,
        validTo: input.validFrom,
        validFromBasis: open.validFromBasis,
      });
    }
    bindings.push({
      ...common,
      channelKey: input.channelKey,
      validFrom: input.validFrom,
      validTo: null,
      validFromBasis: input.validFromBasis,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    return { change: { contractors: [], channels: [], terms: [], bindings }, conflicts: [] };
  };

  return runTrafficChange(
    db,
    { ...options, command: "set" },
    [input.pageLabel],
    (pages) => {
      const page = pages.get(input.pageLabel);
      return page ? [linkLockKey({ pageId: page.id, linkKind: input.linkKind, linkId: input.linkId })] : [];
    },
    // The open row is read only after the link's lock is held.
    derive,
  );
}

export interface TrafficBindingsListing {
  contractors: Array<{ key: string; title: string }>;
  channels: Array<{
    key: string;
    title: string;
    note: string | null;
    contractors: Array<{ contractorKey: string; validFrom: string; validTo: string | null; validFromBasis: TrafficValidFromBasis; note: string | null }>;
  }>;
  bindings: Array<{
    pageLabel: string;
    linkKind: TrafficLinkKind;
    linkId: string;
    channelKey: string;
    validFrom: string;
    validTo: string | null;
    validFromBasis: TrafficValidFromBasis;
    note: string | null;
  }>;
}

/** Everything stored, in a stable order; optional filters by page label and channel key. */
export async function listTrafficBindings(
  db: Database,
  filter: { pageLabel?: string; channelKey?: string } = {},
): Promise<TrafficBindingsListing> {
  const contractors = await db.execute<{ key: string; title: string }>(sql`
    select key, title from traffic_contractors order by key`);
  const channels = await db.execute<{ key: string; title: string; note: string | null }>(sql`
    select key, title, note from traffic_channels
     where ${filter.channelKey === undefined ? sql`true` : sql`key = ${filter.channelKey}`}
     order by key`);
  const terms = await db.execute<{
    channel_key: string; contractor_key: string; valid_from: Date; valid_to: Date | null;
    valid_from_basis: TrafficValidFromBasis; note: string | null;
  }>(sql`
    select c.key as channel_key, k.key as contractor_key, t.valid_from, t.valid_to, t.valid_from_basis, t.note
      from traffic_channel_contractors t
      join traffic_channels c on c.id = t.channel_id
      join traffic_contractors k on k.id = t.contractor_id
     where ${filter.channelKey === undefined ? sql`true` : sql`c.key = ${filter.channelKey}`}
     order by c.key, t.valid_from, t.id`);
  const bindings = await db.execute<{
    page_label: string; link_kind: TrafficLinkKind; link_id: string; channel_key: string;
    valid_from: Date; valid_to: Date | null; valid_from_basis: TrafficValidFromBasis; note: string | null;
  }>(sql`
    select p.label as page_label, b.link_kind, b.platform_link_id as link_id, c.key as channel_key,
           b.valid_from, b.valid_to, b.valid_from_basis, b.note
      from traffic_link_bindings b
      join pages p on p.id = b.platform_account_id
      join traffic_channels c on c.id = b.channel_id
     where ${filter.pageLabel === undefined ? sql`true` : sql`p.label = ${filter.pageLabel}`}
       and ${filter.channelKey === undefined ? sql`true` : sql`c.key = ${filter.channelKey}`}
     order by p.label, b.link_kind, length(b.platform_link_id), b.platform_link_id, b.valid_from, b.id`);

  const isoOf = (value: Date) => new Date(value).toISOString();
  return {
    contractors: contractors.rows.map((row) => ({ key: row.key, title: row.title })),
    channels: channels.rows.map((row) => ({
      key: row.key,
      title: row.title,
      note: row.note,
      contractors: terms.rows
        .filter((term) => term.channel_key === row.key)
        .map((term) => ({
          contractorKey: term.contractor_key,
          validFrom: isoOf(term.valid_from),
          validTo: term.valid_to === null ? null : isoOf(term.valid_to),
          validFromBasis: term.valid_from_basis,
          note: term.note,
        })),
    })),
    bindings: bindings.rows.map((row) => ({
      pageLabel: row.page_label,
      linkKind: row.link_kind,
      linkId: row.link_id,
      channelKey: row.channel_key,
      validFrom: isoOf(row.valid_from),
      validTo: row.valid_to === null ? null : isoOf(row.valid_to),
      validFromBasis: row.valid_from_basis,
      note: row.note,
    })),
  };
}
