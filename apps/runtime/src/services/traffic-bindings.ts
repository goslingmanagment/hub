import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import {
  applyTrafficBindingsChange,
  listTrafficBindings,
  rehangTrafficLink,
  type Database,
  type TrafficBindingsApplyResult,
  type TrafficBindingsChangeSet,
  type TrafficBindingsListing,
  type TrafficChannelTermInput,
  type TrafficIntervalAction,
  type TrafficLinkBindingInput,
} from "@agency_hub_core/db";
import {
  isTrafficLinkKind,
  isTrafficValidFromBasis,
  parseTrafficInstant,
  TRAFFIC_CHANNEL_KEY_PATTERN,
  TRAFFIC_CONTRACTOR_KEY_PATTERN,
  TRAFFIC_LINK_ID_PATTERN,
  type TrafficLinkKind,
  type TrafficValidFromBasis,
} from "@agency_hub_core/shared";

// OnlyFans traffic sources (plan 2026-10-08, PR 11): the owner's CLI over
// "link → channel → contractor" — traffic:bindings:import / :set / :list.
//
// The import file (JSON, `format: "hub.traffic-bindings.v1"`):
//
//   {
//     "format": "hub.traffic-bindings.v1",
//     "comment": "free text or a list of lines; not stored",
//     "contractors": [{ "key": "coraline-red", "title": "Coraline Red" }],
//     "channels": [{
//       "key": "lora.porntoki", "title": "Порнтоки", "note": null,
//       "contractors": [{ "contractor": "coraline-red", "validFrom": "2026-09-16",
//                          "validTo": null, "validFromBasis": "confirmed", "note": "…" }]
//     }],
//     "bindings": [{ "page": "lora-vip-of", "kind": "trial", "link": "11170786",
//                    "channel": "lora.porntoki", "validFrom": "2026-04-01",
//                    "validTo": null, "validFromBasis": "confirmed", "note": "Fikfap" }]
//   }
//
// Instants: a bare YYYY-MM-DD is 00:00 Europe/Moscow; otherwise an ISO
// instant with Z or an offset. `validTo` absent or null = open.
// `validFromBasis` is required on every dated row: `confirmed` or
// `assumed_link_created` — the file states what is known, nothing defaults
// to "confirmed". A `note` absent keeps the stored note, null clears it.
// Unknown fields are refused (a typo must not pass silently).

export const TRAFFIC_BINDINGS_FILE_FORMAT = "hub.traffic-bindings.v1";

export class TrafficBindingsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrafficBindingsFileError";
  }
}

type Json = Record<string, unknown>;

function fail(at: string, message: string): never {
  throw new TrafficBindingsFileError(`${at}: ${message}`);
}

function object(value: unknown, at: string, allowed: readonly string[]): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(at, "expected an object");
  const record = value as Json;
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(at, `unknown field(s) ${unknown.join(", ")} (allowed: ${allowed.join(", ")})`);
  return record;
}

function list(value: unknown, at: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(at, "expected an array");
  return value;
}

function text(value: unknown, at: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(at, "expected a non-empty string");
  if (pattern && !pattern.test(value)) fail(at, `"${value}" does not match ${pattern}`);
  return value;
}

function optionalNote(record: Json, at: string): { note?: string | null } {
  if (!("note" in record)) return {};
  const value = record.note;
  if (value === null) return { note: null };
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) {
    fail(`${at}.note`, "expected null or a string of 1–2000 characters");
  }
  return { note: value };
}

function instant(value: unknown, at: string): Date {
  const raw = text(value, at);
  try {
    return parseTrafficInstant(raw);
  } catch (error) {
    return fail(at, error instanceof Error ? error.message : String(error));
  }
}

function optionalInstant(value: unknown, at: string): Date | null {
  return value === undefined || value === null ? null : instant(value, at);
}

function basis(value: unknown, at: string): TrafficValidFromBasis {
  if (typeof value !== "string" || !isTrafficValidFromBasis(value)) {
    fail(at, "required: \"confirmed\" or \"assumed_link_created\"");
  }
  return value;
}

function linkKind(value: unknown, at: string): TrafficLinkKind {
  if (typeof value !== "string" || !isTrafficLinkKind(value)) fail(at, "expected \"tracking\" or \"trial\"");
  return value;
}

function linkId(value: unknown, at: string): string {
  const raw = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  return text(raw, at, TRAFFIC_LINK_ID_PATTERN);
}

function title(value: unknown, at: string): string {
  const raw = text(value, at);
  if (raw.trim().length > 200) fail(at, "longer than 200 characters");
  return raw;
}

/** The import file → the change set the repository applies. Throws TrafficBindingsFileError. */
export function parseTrafficBindingsFile(source: string): TrafficBindingsChangeSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new TrafficBindingsFileError(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = object(parsed, "file", ["format", "comment", "contractors", "channels", "bindings"]);
  if (root.format !== TRAFFIC_BINDINGS_FILE_FORMAT) fail("file.format", `expected "${TRAFFIC_BINDINGS_FILE_FORMAT}"`);
  if (
    root.comment !== undefined
    && typeof root.comment !== "string"
    && !(Array.isArray(root.comment) && root.comment.every((line) => typeof line === "string"))
  ) {
    fail("file.comment", "expected a string or a list of strings");
  }

  const contractors = list(root.contractors, "contractors").map((item, index) => {
    const at = `contractors[${index}]`;
    const record = object(item, at, ["key", "title"]);
    return { key: text(record.key, `${at}.key`, TRAFFIC_CONTRACTOR_KEY_PATTERN), title: title(record.title, `${at}.title`) };
  });

  const terms: TrafficChannelTermInput[] = [];
  const channels = list(root.channels, "channels").map((item, index) => {
    const at = `channels[${index}]`;
    const record = object(item, at, ["key", "title", "note", "contractors"]);
    const key = text(record.key, `${at}.key`, TRAFFIC_CHANNEL_KEY_PATTERN);
    list(record.contractors, `${at}.contractors`).forEach((termItem, termIndex) => {
      const termAt = `${at}.contractors[${termIndex}]`;
      const term = object(termItem, termAt, ["contractor", "validFrom", "validTo", "validFromBasis", "note"]);
      terms.push({
        channelKey: key,
        contractorKey: text(term.contractor, `${termAt}.contractor`, TRAFFIC_CONTRACTOR_KEY_PATTERN),
        validFrom: instant(term.validFrom, `${termAt}.validFrom`),
        validTo: optionalInstant(term.validTo, `${termAt}.validTo`),
        validFromBasis: basis(term.validFromBasis, `${termAt}.validFromBasis`),
        ...optionalNote(term, termAt),
      });
    });
    return { key, title: title(record.title, `${at}.title`), ...optionalNote(record, at) };
  });

  const bindings: TrafficLinkBindingInput[] = list(root.bindings, "bindings").map((item, index) => {
    const at = `bindings[${index}]`;
    const record = object(item, at, ["page", "kind", "link", "channel", "validFrom", "validTo", "validFromBasis", "note"]);
    return {
      pageLabel: text(record.page, `${at}.page`),
      linkKind: linkKind(record.kind, `${at}.kind`),
      linkId: linkId(record.link, `${at}.link`),
      channelKey: text(record.channel, `${at}.channel`, TRAFFIC_CHANNEL_KEY_PATTERN),
      validFrom: instant(record.validFrom, `${at}.validFrom`),
      validTo: optionalInstant(record.validTo, `${at}.validTo`),
      validFromBasis: basis(record.validFromBasis, `${at}.validFromBasis`),
      ...optionalNote(record, at),
    };
  });

  return { contractors, channels, terms, bindings };
}

export function trafficCliActor(): string {
  return `cli@${hostname()} pid ${process.pid}`;
}

function intervalSummary(action: TrafficIntervalAction) {
  const show = (row: { target: string; validFrom: Date; validTo: Date | null; validFromBasis: string; note: string | null }) => ({
    target: row.target,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo === null ? null : row.validTo.toISOString(),
    validFromBasis: row.validFromBasis,
    note: row.note,
  });
  if (action.action === "create") return { action: action.action, after: show(action.row) };
  if (action.action === "unchanged") return { action: action.action, row: show(action.row) };
  return { action: action.action, before: show(action.before), after: show(action.after) };
}

/** The CLI's JSON view of a plan: counts, conflicts, warnings and every change (unchanged rows only counted). */
export function describeTrafficBindingsResult(result: TrafficBindingsApplyResult) {
  const { plan } = result;
  const count = (actions: Array<{ action: string }>) => {
    const counts: Record<string, number> = {};
    for (const { action } of actions) counts[action] = (counts[action] ?? 0) + 1;
    return counts;
  };
  return {
    written: result.written,
    batchId: result.batchId,
    counts: {
      contractors: count(plan.contractors),
      channels: count(plan.channels),
      channelContractors: count(plan.terms.map((term) => term.change)),
      linkBindings: count(plan.bindings.map((binding) => binding.change)),
    },
    conflicts: plan.conflicts,
    warnings: plan.warnings,
    changes: {
      contractors: plan.contractors.filter((c) => c.action !== "unchanged"),
      channels: plan.channels.filter((c) => c.action !== "unchanged"),
      channelContractors: plan.terms
        .filter((term) => term.change.action !== "unchanged")
        .map((term) => ({ channel: term.channelKey, ...intervalSummary(term.change) })),
      linkBindings: plan.bindings
        .filter((binding) => binding.change.action !== "unchanged")
        .map((binding) => ({ ...binding.link, ...intervalSummary(binding.change) })),
    },
    auditEventIds: result.auditEventIds,
  };
}

export async function runTrafficBindingsImport(
  db: Database,
  input: { file: string; write: boolean; actor?: string; afterPlan?: () => Promise<void> },
) {
  const source = await readFile(input.file, "utf8");
  const change = parseTrafficBindingsFile(source);
  const result = await applyTrafficBindingsChange(db, change, {
    write: input.write,
    actor: input.actor ?? trafficCliActor(),
    command: "import",
    auditContext: {
      file: path.basename(input.file),
      fileSha256: createHash("sha256").update(source).digest("hex"),
    },
    ...(input.afterPlan ? { afterPlan: input.afterPlan } : {}),
  });
  return describeTrafficBindingsResult(result);
}

export async function runTrafficBindingsSet(
  db: Database,
  input: {
    page: string;
    kind: string;
    link: string;
    channel: string;
    from: string;
    basis: string;
    note?: string;
    write: boolean;
    actor?: string;
  },
) {
  const kind = linkKind(input.kind, "--kind");
  const result = await rehangTrafficLink(db, {
    pageLabel: text(input.page, "--page"),
    linkKind: kind,
    linkId: linkId(input.link, "--link"),
    channelKey: text(input.channel, "--channel", TRAFFIC_CHANNEL_KEY_PATTERN),
    validFrom: instant(input.from, "--from"),
    validFromBasis: basis(input.basis, "--basis"),
    ...(input.note === undefined ? {} : { note: input.note }),
  }, { write: input.write, actor: input.actor ?? trafficCliActor() });
  return describeTrafficBindingsResult(result);
}

export async function runTrafficBindingsList(
  db: Database,
  filter: { page?: string; channel?: string },
): Promise<TrafficBindingsListing> {
  return listTrafficBindings(db, {
    ...(filter.page === undefined ? {} : { pageLabel: filter.page }),
    ...(filter.channel === undefined ? {} : { channelKey: filter.channel }),
  });
}
