import { createHash } from "node:crypto";

import {
  AGENT_CLAIM_FIELDS,
  agentCoverageStatusEnum,
  agentDatasetEnum,
  agentDatasetFilterOpEnum,
  agentHistoryItemStateEnum,
  agentHistoryRequestStateEnum,
  agentMessageDirectionEnum,
  agentObservationSourceEnum,
  agentResolveHintEnum,
  agentSenderRoleEnum,
  agentThreadsOrderByEnum,
  agentTimelineLaneEnum,
  platformEnum,
  sortDirEnum,
  type AgentHistoryDepth,
  type AgentHistoryFanRef,
} from "@agency_hub_core/contracts";
import { KernelApiError, type KernelClient } from "@kernel/sdk";

/**
 * The command table: exactly one command per agentKey operation, and nothing else.
 *
 * WHY ONE-TO-ONE. The agent on the other end of this CLI reasons about the plane
 * through the operations the contract declares; a command that quietly fanned out
 * into three calls would put a second, undocumented API between the agent and the
 * evidence envelope, and the envelope is the whole point. Composite rituals
 * (`investigate`, `customs-scan`) are a later slice, built ON these, never instead.
 *
 * THE COMPOSITES THAT EXIST are marked `composite: true` and say COMPOSITE in
 * their summary: `history-request-batch` (one create per page and 1000 fans)
 * and `history-status --wait` (polls one request until it ends). Each makes
 * several calls of ONE documented operation and nothing else, so the evidence
 * envelope of every call is still the operation's own.
 *
 * WHAT IS NOT HERE, and why it never will be: operation 9b (observation payloads)
 * and #13 (hydration decisions) are OWNER-SESSION. An agent key cannot call them
 * by construction, so offering a command for them would only produce a confident
 * 401. They live in the owner CLI and the dashboard.
 *
 * Every command builds a typed request and returns the SDK's validated response.
 * The CLI never assembles a URL and never parses a body — that is the SDK's job,
 * and going around it would cost the response validation this plane relies on.
 */

/** How one flag's raw text becomes a request value. */
export type HubOptionKind = "string" | "number" | "boolean" | "tristate" | "list";

export interface HubOption {
  kind: HubOptionKind;
  describe: string;
}

export type HubOptionValues = Record<string, string | boolean | string[] | undefined>;

/** A flag was missing, repeated, or carried a value the contract cannot use. */
export class HubUsageError extends Error {}

// --- value readers -------------------------------------------------------

function readString(values: HubOptionValues, name: string): string | undefined {
  const value = values[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HubUsageError(`--${name} takes a single value`);
  }
  return value;
}

function requireString(values: HubOptionValues, name: string): string {
  const value = readString(values, name);
  if (value === undefined || value === "") {
    throw new HubUsageError(`--${name} is required`);
  }
  return value;
}

function readNumber(values: HubOptionValues, name: string): number | undefined {
  const value = readString(values, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HubUsageError(`--${name} must be a number, got "${value}"`);
  }
  return parsed;
}

/**
 * A THREE-state flag: absent, `true`, or `false`.
 *
 * Written as `--has-media true` rather than a bare `--has-media` on purpose.
 * These filters are optional on the wire and "absent" means something different
 * from "false": absent asks for both, `false` asks for the ones without. A bare
 * boolean flag could express only two of the three, and the missing third is the
 * one an audit usually wants.
 */
function readTristate(values: HubOptionValues, name: string): boolean | undefined {
  const value = readString(values, name);
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HubUsageError(`--${name} must be true or false, got "${value}"`);
}

function readFlag(values: HubOptionValues, name: string): boolean {
  return values[name] === true;
}

/**
 * A flag whose values are a CLOSED set, checked against the contract's own enum.
 *
 * The list is never typed out here: it comes from the same `z.enum` the route
 * validates against, so a vocabulary that grows in the contract grows in this CLI
 * for free, and one that shrinks becomes a compile error rather than a flag that
 * silently starts failing at the hub. The cast is inside the branch where the
 * membership test already passed.
 */
function readEnum<T extends string>(
  values: HubOptionValues,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = readString(values, name);
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new HubUsageError(`--${name} must be one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value as T;
}

function requireEnum<T extends string>(
  values: HubOptionValues,
  name: string,
  allowed: readonly T[],
): T {
  const value = readEnum(values, name, allowed);
  if (value === undefined) {
    throw new HubUsageError(`--${name} is required (one of ${allowed.join(", ")})`);
  }
  return value;
}

function readEnumList<T extends string>(
  values: HubOptionValues,
  name: string,
  allowed: readonly T[],
): T[] | undefined {
  const list = readList(values, name);
  if (list === undefined) {
    return undefined;
  }
  return list.map((entry) => {
    if (!(allowed as readonly string[]).includes(entry)) {
      throw new HubUsageError(`--${name} must be one of ${allowed.join(", ")}, got "${entry}"`);
    }
    return entry as T;
  });
}

function readList(values: HubOptionValues, name: string): string[] | undefined {
  const value = values[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value;
  }
  throw new HubUsageError(`--${name} takes values, not a bare flag`);
}

/**
 * Drops the keys whose value is `undefined`.
 *
 * `exactOptionalPropertyTypes` is on across this workspace, so `{ from: undefined }`
 * is NOT the same type as `{}` and is rejected where `from?: string` is expected.
 * This is the one place the difference is bridged, with one cast, instead of a
 * conditional spread on every one of the roughly hundred optional flags below.
 */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

function defined<T extends Record<string, unknown>>(source: T): Defined<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as Defined<T>;
}

function claimFields(values: HubOptionValues) {
  return readEnumList(values, "claim-field", AGENT_CLAIM_FIELDS);
}

/**
 * The GET encoding of a claim: two flat fields, because the SDK serializes only
 * flat query values and Fastify is not configured for nested query parsing.
 *
 * Both keys are always present (carrying `undefined` when no claim was declared)
 * because the query schema preprocesses `claimFields`, and a preprocessed field's
 * INPUT type is `unknown` — required in the type even though it is optional on
 * the wire.
 */
function claimQuery(values: HubOptionValues) {
  const fields = claimFields(values);
  return {
    claimFields: fields,
    claimTargets: fields === undefined ? undefined : ("all_in_scope" as const),
  };
}

/** The POST encoding of the same claim. */
function claimBody(values: HubOptionValues) {
  const fields = claimFields(values);
  if (fields === undefined) {
    return {};
  }
  return { claim: { fields, targets: "all_in_scope" as const } };
}

/**
 * `--filter field:op[:value]`.
 *
 * The value is JSON when it parses as JSON and a plain string otherwise, which is
 * what makes `in` usable from a shell (`--filter tier:in:["gold","silver"]`)
 * without inventing a second syntax for lists. `is_null` and `is_not_null` carry
 * no value at all, and the contract rejects one that does.
 */
type HubDatasetScalar = string | number | boolean | string[] | null;

function parseFilterValue(raw: string): HubDatasetScalar {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: a bare word is a string, which is what a shell mostly types.
    return raw;
  }
  // Platform user IDs are wire strings and can be longer than JavaScript's
  // safe-integer range. JSON.parse would silently round a bare numeric ID and
  // query the wrong person, so preserve unsafe integers exactly as typed.
  if (typeof parsed === "number" && Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) {
    return raw;
  }
  if (parsed === null || typeof parsed === "string" || typeof parsed === "number"
    || typeof parsed === "boolean") {
    return parsed;
  }
  if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
    return parsed;
  }
  throw new HubUsageError(
    `--filter value must be a scalar or an array of strings, got "${raw}"`,
  );
}

function parseFilter(raw: string) {
  const firstColon = raw.indexOf(":");
  const secondColon = firstColon < 0 ? -1 : raw.indexOf(":", firstColon + 1);
  if (firstColon <= 0) {
    throw new HubUsageError(`--filter must look like field:op[:value], got "${raw}"`);
  }
  const field = raw.slice(0, firstColon);
  const rawOp = secondColon < 0 ? raw.slice(firstColon + 1) : raw.slice(firstColon + 1, secondColon);
  const ops: readonly string[] = agentDatasetFilterOpEnum.options;
  if (!ops.includes(rawOp)) {
    throw new HubUsageError(`--filter op must be one of ${ops.join(", ")}, got "${rawOp}"`);
  }
  const op = rawOp as (typeof agentDatasetFilterOpEnum.options)[number];
  if (secondColon < 0) {
    return { field, op };
  }
  return { field, op, value: parseFilterValue(raw.slice(secondColon + 1)) };
}

/** `--sort field:dir`. */
function parseSort(raw: string) {
  const separator = raw.indexOf(":");
  if (separator <= 0) {
    throw new HubUsageError(`--sort must look like field:asc or field:desc, got "${raw}"`);
  }
  const rawDir = raw.slice(separator + 1);
  const dirs: readonly string[] = sortDirEnum.options;
  if (!dirs.includes(rawDir)) {
    throw new HubUsageError(`--sort direction must be one of ${dirs.join(", ")}, got "${rawDir}"`);
  }
  return {
    field: raw.slice(0, separator),
    dir: rawDir as (typeof sortDirEnum.options)[number],
  };
}

// --- shared option groups ------------------------------------------------

const CLAIM_OPTION: Record<string, HubOption> = {
  "claim-field": {
    kind: "list",
    describe: "Declare a claim field (repeatable). Makes the answer state that field's observability before any row is read.",
  },
};

const WINDOW_OPTIONS: Record<string, HubOption> = {
  from: { kind: "string", describe: "Window start, RFC 3339 with an explicit offset" },
  to: { kind: "string", describe: "Window end, RFC 3339 with an explicit offset" },
};

const PAGING_OPTIONS: Record<string, HubOption> = {
  limit: { kind: "number", describe: "Maximum records in this response" },
  cursor: {
    kind: "string",
    describe: "Continue a traversal. Do NOT resend the filters: the cursor carries them.",
  },
};

// --- the commands --------------------------------------------------------

/** What a command may touch besides the client: injected, so tests stay hermetic. */
export interface HubRunDeps {
  /** A local file's text, or null when it cannot be read. */
  readFile(path: string): string | null;
  sleep(ms: number): Promise<void>;
  /** Milliseconds since the epoch. */
  now(): number;
  randomUUID(): string;
}

/**
 * The answer of a COMPOSITE command: the document to print as `data`, how many
 * of its calls failed (any failure exits 4, with the document still printed so
 * the calls that did land are not lost), and what the composite itself adds.
 */
export class HubCompositeResult {
  constructor(
    readonly data: unknown,
    readonly failed: number,
    readonly meta: Record<string, unknown>,
  ) {}
}

export interface HubCommand {
  name: string;
  operation: string;
  summary: string;
  options: Record<string, HubOption>;
  /** Several calls of `operation` (see the header). */
  composite?: true;
  /** A next step to print beside a refusal this command expects. */
  hint?(error: { status: number | null; code: string | null }): string | null;
  run(client: KernelClient, values: HubOptionValues, deps: HubRunDeps): Promise<unknown>;
}

// --- history requests (the Fansly Sync Engine, plan §4) ---------------------

const HISTORY_UNAVAILABLE_CODE = "history_requests_unavailable_on_page";
/** At most this many fans per request (the contract's own ceiling). */
export const HUB_HISTORY_MAX_FANS = 1000;
const HISTORY_MIN_POLL_SECONDS = 15;
const MS_PER_SECOND = 1000;

/**
 * The fallback a 409 `history_requests_unavailable_on_page` points at. History
 * requests open page by page as pages switch to the Fansly Sync Engine; until
 * then the hydration route is the remedy (docs/agent-read-skill.md).
 */
export const HUB_HISTORY_FALLBACK_HINT =
  "History requests work only on pages switched to the Fansly Sync Engine. On this page ask as before:"
  + " POST /api/v1/agent/pages/<pageLabel>/threads/<conversationRef>/hydration-requests, one thread per request"
  + " (docs/agent-read-skill.md, \"Asking for more data\").";

function historyHint(error: { status: number | null; code: string | null }): string | null {
  return error.code === HISTORY_UNAVAILABLE_CODE ? HUB_HISTORY_FALLBACK_HINT : null;
}

/** A fan ref as a list line spells it: a chat link, `conversation:<id>`, or a
 *  fan's Fansly account id. */
export function parseHubFanRef(raw: string): AgentHistoryFanRef {
  const ref = raw.trim();
  if (ref.toLowerCase().includes("fansly.com/")) return { kind: "chat_url", url: ref };
  if (ref.startsWith("conversation:")) return { kind: "conversation", conversationRef: ref.slice("conversation:".length) };
  return { kind: "fan", platformUserId: ref };
}

/** One fan per line; blank lines and `#` comments are skipped. */
export function parseHubFanList(text: string): AgentHistoryFanRef[] {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map(parseHubFanRef);
}

function fanKey(fan: AgentHistoryFanRef): string {
  const ref = fan.kind === "fan" ? fan.platformUserId : fan.kind === "conversation" ? fan.conversationRef : fan.url;
  return `${fan.kind}\u0000${ref.trim()}`;
}

/** The same fan twice is one fan (the hub refuses a duplicate). */
function uniqueFans(fans: readonly AgentHistoryFanRef[]): AgentHistoryFanRef[] {
  const seen = new Set<string>();
  return fans.filter((fan) => {
    const key = fanKey(fan);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readTextFile(deps: HubRunDeps, path: string): string {
  const text = deps.readFile(path);
  if (text === null) {
    throw new HubUsageError(`--file ${path} cannot be read`);
  }
  return text;
}

/** `--all` XOR `--latest N`: the depth is required (plan §4.1). */
function historyDepth(values: HubOptionValues): AgentHistoryDepth {
  const all = readFlag(values, "all");
  const latest = readNumber(values, "latest");
  if (all === (latest !== undefined)) {
    throw new HubUsageError("say the depth: --all (to the first message) or --latest <n>");
  }
  if (latest !== undefined) {
    if (!Number.isInteger(latest) || latest < 1 || latest > 1_000_000) {
      throw new HubUsageError(`--latest must be an integer in 1..1000000, got "${String(latest)}"`);
    }
    return { kind: "latest", count: latest };
  }
  return { kind: "all" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readIdempotencyKey(values: HubOptionValues): string | undefined {
  const key = readString(values, "idempotency-key");
  if (key !== undefined && !UUID.test(key)) {
    throw new HubUsageError(`--idempotency-key must be a uuid, got "${key}"`);
  }
  return key;
}

/**
 * A chunk's own key, derived from the batch key: re-running the same batch
 * with the same `--idempotency-key` re-files the same requests (each answers
 * `coalesced`), never a second copy. Shaped as a version-4 uuid.
 */
export function hubChunkIdempotencyKey(base: string, pageLabel: string, chunk: number): string {
  const hex = createHash("sha256").update(`${base.toLowerCase()}\u0000${pageLabel}\u0000${chunk}`).digest("hex");
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Error METADATA of one failed call of a composite, never its body. */
function compositeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof KernelApiError)) {
    throw error;
  }
  const hint = historyHint(error);
  return {
    status: error.status,
    code: error.code,
    message: error.message.length <= 500 ? error.message : `${error.message.slice(0, 500)}... (truncated)`,
    ...(hint === null ? {} : { hint }),
  };
}

/** `pageLabel<TAB>fan` lines, grouped by page in first-seen order. */
export function parseHubBatchFile(text: string): Map<string, AgentHistoryFanRef[]> {
  const byPage = new Map<string, AgentHistoryFanRef[]>();
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    const tab = rawLine.indexOf("\t");
    const pageLabel = tab < 0 ? "" : rawLine.slice(0, tab).trim();
    const ref = tab < 0 ? "" : rawLine.slice(tab + 1).trim();
    if (pageLabel === "" || ref === "") {
      throw new HubUsageError(`--file line ${index + 1}: expected pageLabel<TAB>fan`);
    }
    const fans = byPage.get(pageLabel) ?? [];
    fans.push(parseHubFanRef(ref));
    byPage.set(pageLabel, fans);
  });
  return byPage;
}

const HISTORY_DEPTH_OPTIONS: Record<string, HubOption> = {
  all: { kind: "boolean", describe: "Read each chat to its first message (proven by an empty page)" },
  latest: { kind: "number", describe: "Read the latest N messages of each chat (fan's and model's)" },
};

const HISTORY_FILING_OPTIONS: Record<string, HubOption> = {
  ...HISTORY_DEPTH_OPTIONS,
  reason: { kind: "string", describe: "Why (required, 1-1000 chars; the hub stores a digest only)" },
  "idempotency-key": {
    kind: "string",
    describe: "A uuid making the call repeat-safe: the same key and fans answer the same request (default: a new key)",
  },
};

export const HUB_COMMANDS: readonly HubCommand[] = [
  {
    name: "capabilities",
    operation: "agentCapabilities",
    summary: "What this deployment serves, what THIS key may read, and today's budget. Start here.",
    options: {},
    run: (client) => client.agentCapabilities(),
  },
  {
    name: "resolve",
    operation: "agentResolve",
    summary: "Turn URLs, slugs, usernames or native ids into fan identities (tries every key).",
    options: {
      input: { kind: "list", describe: "A raw identifier (repeatable)" },
      hint: {
        kind: "string",
        describe: "auto | url | platformUserId | username | alias | displayName (default auto)",
      },
      platform: { kind: "string", describe: "Restrict to one platform" },
      "no-aliases": { kind: "boolean", describe: "Skip alias expansion" },
      "no-threads": { kind: "boolean", describe: "Skip thread lookup" },
      ...CLAIM_OPTION,
    },
    run: (client, values) => {
      const inputs = readList(values, "input");
      if (inputs === undefined || inputs.length === 0) {
        throw new HubUsageError("--input is required (repeatable)");
      }
      const hint = readEnum(values, "hint", agentResolveHintEnum.options);
      return client.agentResolve({
        body: {
          inputs: inputs.map((raw) => (hint === undefined ? { raw } : { raw, hint })),
          includeAliases: !readFlag(values, "no-aliases"),
          includeThreads: !readFlag(values, "no-threads"),
          ...defined({ platform: readEnum(values, "platform", platformEnum.options) }),
          ...claimBody(values),
        },
      });
    },
  },
  {
    name: "person",
    operation: "agentPerson",
    summary: "One fan across every granted page: identity, memberships, threads, money, subscriptions.",
    options: {
      platform: { kind: "string", describe: "fansly | onlyfans (required)" },
      user: { kind: "string", describe: "Native platform user id (required)" },
      "page-label": { kind: "string", describe: "Narrow to one page" },
      ...CLAIM_OPTION,
    },
    run: (client, values) => client.agentPerson({
      params: {
        platform: requireEnum(values, "platform", platformEnum.options),
        platformUserId: requireString(values, "user"),
      },
      query: {
        ...defined({ pageLabel: readString(values, "page-label") }),
        ...claimQuery(values),
      },
    }),
  },
  {
    name: "timeline",
    operation: "agentPersonTimeline",
    summary: "One fan's merged timeline across lanes (money, post-tip attribution, subscriptions, follows, message refs).",
    options: {
      platform: { kind: "string", describe: "fansly | onlyfans (required)" },
      user: { kind: "string", describe: "Native platform user id (required)" },
      lane: { kind: "list", describe: "Restrict to a lane (repeatable)" },
      "page-label": { kind: "string", describe: "Narrow to one page" },
      "sort-dir": { kind: "string", describe: "asc | desc (default desc)" },
      ...WINDOW_OPTIONS,
      ...PAGING_OPTIONS,
      ...CLAIM_OPTION,
    },
    run: (client, values) => client.agentPersonTimeline({
      params: {
        platform: requireEnum(values, "platform", platformEnum.options),
        platformUserId: requireString(values, "user"),
      },
      query: {
        lanes: readEnumList(values, "lane", agentTimelineLaneEnum.options),
        ...defined({
          from: readString(values, "from"),
          to: readString(values, "to"),
          pageLabel: readString(values, "page-label"),
          sortDir: readEnum(values, "sort-dir", sortDirEnum.options),
          limit: readNumber(values, "limit"),
          cursor: readString(values, "cursor"),
        }),
        ...claimQuery(values),
      },
    }),
  },
  {
    name: "threads",
    operation: "agentThreads",
    summary: "Cross-page DM thread inventory with per-thread capture bounds. Takes no window.",
    options: {
      platform: { kind: "string", describe: "fansly | onlyfans" },
      "page-label": { kind: "string", describe: "Narrow to one page" },
      "person-platform": { kind: "string", describe: "Fan platform (pairs with --person-user)" },
      "person-user": { kind: "string", describe: "Fan platform user id (pairs with --person-platform)" },
      "coverage-status": { kind: "string", describe: "Filter by coverage status" },
      quarantined: { kind: "tristate", describe: "true | false" },
      "has-messages-since": { kind: "string", describe: "Only threads with messages after this instant" },
      "min-stored-messages": { kind: "number", describe: "Only threads holding at least this many stored messages" },
      "order-by": { kind: "string", describe: "lastMessageAt | storedMessageCount | pageLabel" },
      "sort-dir": { kind: "string", describe: "asc | desc (default desc)" },
      ...PAGING_OPTIONS,
      ...CLAIM_OPTION,
    },
    run: (client, values) => client.agentThreads({
      query: {
        ...defined({
          platform: readEnum(values, "platform", platformEnum.options),
          pageLabel: readString(values, "page-label"),
          personPlatform: readEnum(values, "person-platform", platformEnum.options),
          personPlatformUserId: readString(values, "person-user"),
          coverageStatus: readEnum(values, "coverage-status", agentCoverageStatusEnum.options),
          quarantined: readTristate(values, "quarantined"),
          hasMessagesSince: readString(values, "has-messages-since"),
          minStoredMessages: readNumber(values, "min-stored-messages"),
          orderBy: readEnum(values, "order-by", agentThreadsOrderByEnum.options),
          sortDir: readEnum(values, "sort-dir", sortDirEnum.options),
          limit: readNumber(values, "limit"),
          cursor: readString(values, "cursor"),
        }),
        ...claimQuery(values),
      },
    }),
  },
  {
    name: "transcript",
    operation: "agentThreadMessages",
    summary: "The full-fidelity transcript of ONE thread. Needs read:messages; every call is audited.",
    options: {
      "page-label": { kind: "string", describe: "Page holding the thread (required)" },
      conversation: { kind: "string", describe: "Native conversation ref (required)" },
      direction: { kind: "string", describe: "Message direction filter" },
      "sender-role": { kind: "string", describe: "Sender role filter" },
      "has-media": { kind: "tristate", describe: "true | false" },
      "has-price": { kind: "tristate", describe: "true | false" },
      "is-tip": { kind: "tristate", describe: "true | false" },
      "include-deleted": {
        kind: "tristate",
        describe: "true | false (DEFAULT true: a deleted message is a fact of the investigation)",
      },
      "sort-dir": { kind: "string", describe: "asc | desc (default asc)" },
      ...WINDOW_OPTIONS,
      ...PAGING_OPTIONS,
      ...CLAIM_OPTION,
    },
    run: (client, values) => client.agentThreadMessages({
      params: {
        pageLabel: requireString(values, "page-label"),
        conversationRef: requireString(values, "conversation"),
      },
      query: {
        ...defined({
          from: readString(values, "from"),
          to: readString(values, "to"),
          direction: readEnum(values, "direction", agentMessageDirectionEnum.options),
          senderRole: readEnum(values, "sender-role", agentSenderRoleEnum.options),
          hasMedia: readTristate(values, "has-media"),
          hasPrice: readTristate(values, "has-price"),
          isTip: readTristate(values, "is-tip"),
          includeDeleted: readTristate(values, "include-deleted"),
          sortDir: readEnum(values, "sort-dir", sortDirEnum.options),
          limit: readNumber(values, "limit"),
          cursor: readString(values, "cursor"),
        }),
        ...claimQuery(values),
      },
    }),
  },
  {
    name: "search",
    operation: "agentSearchMessages",
    summary: "Bounded full-text search over the message archive. Bounded on purpose: it does not paginate.",
    options: {
      q: { kind: "string", describe: "Search text (required, 2-200 chars)" },
      platform: { kind: "string", describe: "fansly | onlyfans" },
      "page-label": { kind: "list", describe: "Restrict to a page (repeatable)" },
      "person-platform": { kind: "string", describe: "Fan platform (pairs with --person-user)" },
      "person-user": { kind: "string", describe: "Fan platform user id (pairs with --person-platform)" },
      "conversation-ref": { kind: "list", describe: "Restrict to a conversation (repeatable)" },
      direction: { kind: "string", describe: "Message direction filter" },
      "sender-role": { kind: "string", describe: "Sender role filter" },
      snippet: {
        kind: "boolean",
        describe: "Return match snippets. Verbatim text: needs read:messages and is audited.",
      },
      limit: { kind: "number", describe: "Maximum matches (max 100)" },
      ...WINDOW_OPTIONS,
      ...CLAIM_OPTION,
    },
    run: (client, values) => {
      const personPlatform = readEnum(values, "person-platform", platformEnum.options);
      const personUser = readString(values, "person-user");
      if ((personPlatform === undefined) !== (personUser === undefined)) {
        throw new HubUsageError("--person-platform and --person-user are an atomic pair");
      }
      return client.agentSearchMessages({
        body: {
          q: requireString(values, "q"),
          includeSnippet: readFlag(values, "snippet"),
          ...defined({
            from: readString(values, "from"),
            to: readString(values, "to"),
            platform: readEnum(values, "platform", platformEnum.options),
            pageLabels: readList(values, "page-label"),
            conversationRefs: readList(values, "conversation-ref"),
            direction: readEnum(values, "direction", agentMessageDirectionEnum.options),
            senderRole: readEnum(values, "sender-role", agentSenderRoleEnum.options),
            limit: readNumber(values, "limit"),
            person: personPlatform !== undefined && personUser !== undefined
              ? { platform: personPlatform, platformUserId: personUser }
              : undefined,
          }),
          ...claimBody(values),
        },
      });
    },
  },
  {
    name: "coverage",
    operation: "agentCoverage",
    summary: "The capture axis on its own: what was ever captured for this scope and window.",
    options: {
      platform: { kind: "string", describe: "fansly | onlyfans" },
      "page-label": { kind: "string", describe: "Narrow to one page" },
      "person-platform": { kind: "string", describe: "Fan platform (pairs with --person-user)" },
      "person-user": { kind: "string", describe: "Fan platform user id (pairs with --person-platform)" },
      conversation: { kind: "string", describe: "Narrow to one conversation ref" },
      ...WINDOW_OPTIONS,
      ...PAGING_OPTIONS,
      ...CLAIM_OPTION,
    },
    run: (client, values) => client.agentCoverage({
      query: {
        ...defined({
          from: readString(values, "from"),
          to: readString(values, "to"),
          platform: readEnum(values, "platform", platformEnum.options),
          pageLabel: readString(values, "page-label"),
          personPlatform: readEnum(values, "person-platform", platformEnum.options),
          personPlatformUserId: readString(values, "person-user"),
          conversationRef: readString(values, "conversation"),
          limit: readNumber(values, "limit"),
          cursor: readString(values, "cursor"),
        }),
        ...claimQuery(values),
      },
    }),
  },
  {
    name: "observations",
    operation: "agentObservations",
    summary: "Capture-journal ENVELOPES: kind, source, timing, sizes, links. Never the payload bodies.",
    options: {
      platform: { kind: "string", describe: "fansly | onlyfans" },
      "page-label": { kind: "string", describe: "Narrow to one page" },
      source: { kind: "string", describe: "Capture source filter" },
      kind: { kind: "string", describe: "Observation kind filter" },
      producer: { kind: "string", describe: "Producer filter" },
      "parse-version": { kind: "number", describe: "Parse version filter" },
      "sort-dir": { kind: "string", describe: "asc | desc (default desc)" },
      ...WINDOW_OPTIONS,
      ...PAGING_OPTIONS,
    },
    run: (client, values) => client.agentObservations({
      query: defined({
        from: readString(values, "from"),
        to: readString(values, "to"),
        platform: readEnum(values, "platform", platformEnum.options),
        pageLabel: readString(values, "page-label"),
        source: readEnum(values, "source", agentObservationSourceEnum.options),
        kind: readString(values, "kind"),
        producer: readString(values, "producer"),
        parseVersion: readNumber(values, "parse-version"),
        sortDir: readEnum(values, "sort-dir", sortDirEnum.options),
        limit: readNumber(values, "limit"),
        cursor: readString(values, "cursor"),
      }),
    }),
  },
  {
    name: "dataset",
    operation: "agentDatasetQuery",
    summary: "A typed query over one registered dataset for one page. Names come from `hub capabilities`.",
    options: {
      "page-label": { kind: "string", describe: "Page to query (required)" },
      dataset: { kind: "string", describe: "Registered dataset name (required)" },
      summary: {
        kind: "boolean",
        describe: "Return one exact summary of matching Hub transaction rows instead of paginated rows (transactions only)",
      },
      filter: { kind: "list", describe: "field:op[:value] (repeatable, max 10)" },
      sort: { kind: "list", describe: "field:asc | field:desc (max 1 in cursor v1)" },
      ...WINDOW_OPTIONS,
      ...PAGING_OPTIONS,
      ...CLAIM_OPTION,
    },
    run: (client, values) => {
      const filters = readList(values, "filter");
      const sorts = readList(values, "sort");
      return client.agentDatasetQuery({
        params: {
          pageLabel: requireString(values, "page-label"),
          dataset: requireEnum(values, "dataset", agentDatasetEnum.options),
        },
        body: {
          ...defined({
            from: readString(values, "from"),
            to: readString(values, "to"),
            summary: readFlag(values, "summary") ? true : undefined,
            filters: filters?.map(parseFilter),
            sort: sorts?.map(parseSort),
            limit: readNumber(values, "limit"),
            cursor: readString(values, "cursor"),
          }),
          ...claimBody(values),
        },
      });
    },
  },
  {
    name: "history-request",
    operation: "agentHistoryRequestCreate",
    summary:
      "File a history request: up to 1000 fans of ONE page and a depth. Works on pages switched to the Fansly"
      + " Sync Engine; elsewhere the hub answers 409 and the document carries the hydration fallback.",
    options: {
      "page-label": { kind: "string", describe: "The page whose chats to read (required)" },
      fan: { kind: "list", describe: "A fan's Fansly account id (repeatable)" },
      conversation: { kind: "list", describe: "A chat's conversation ref (repeatable)" },
      "chat-url": { kind: "list", describe: "A chat link https://fansly.com/messages/<id> (repeatable)" },
      file: {
        kind: "string",
        describe: "A file with one fan per line: account id, chat link, or conversation:<ref>",
      },
      ...HISTORY_FILING_OPTIONS,
      ...CLAIM_OPTION,
    },
    hint: historyHint,
    run: (client, values, deps) => {
      const path = readString(values, "file");
      const fans = uniqueFans([
        ...(readList(values, "fan") ?? []).map((platformUserId): AgentHistoryFanRef => ({ kind: "fan", platformUserId })),
        ...(readList(values, "conversation") ?? [])
          .map((conversationRef): AgentHistoryFanRef => ({ kind: "conversation", conversationRef })),
        ...(readList(values, "chat-url") ?? []).map((url): AgentHistoryFanRef => ({ kind: "chat_url", url })),
        ...(path === undefined ? [] : parseHubFanList(readTextFile(deps, path))),
      ]);
      if (fans.length === 0) {
        throw new HubUsageError("name at least one fan: --fan, --conversation, --chat-url or --file");
      }
      if (fans.length > HUB_HISTORY_MAX_FANS) {
        throw new HubUsageError(
          `at most ${HUB_HISTORY_MAX_FANS} fans per request (got ${fans.length}); use history-request-batch`,
        );
      }
      return client.agentHistoryRequestCreate({
        params: { pageLabel: requireString(values, "page-label") },
        body: {
          fans,
          depth: historyDepth(values),
          reason: requireString(values, "reason"),
          idempotencyKey: readIdempotencyKey(values) ?? deps.randomUUID(),
          ...claimBody(values),
        },
      });
    },
  },
  {
    name: "history-request-batch",
    operation: "agentHistoryRequestCreate",
    composite: true,
    summary:
      "COMPOSITE (several calls): file history requests from a pageLabel<TAB>fan list, one request per page"
      + " and per 1000 fans. Prints one result per request; any refused request exits 4.",
    options: {
      file: { kind: "string", describe: "Lines pageLabel<TAB>fan (account id, chat link, or conversation:<ref>); required" },
      ...HISTORY_FILING_OPTIONS,
    },
    hint: historyHint,
    run: async (client, values, deps) => {
      const byPage = parseHubBatchFile(readTextFile(deps, requireString(values, "file")));
      if (byPage.size === 0) {
        throw new HubUsageError("--file names no fan");
      }
      const depth = historyDepth(values);
      const reason = requireString(values, "reason");
      const baseKey = readIdempotencyKey(values);
      const requests: Array<Record<string, unknown>> = [];
      let failed = 0;
      for (const [pageLabel, pageFans] of byPage) {
        const fans = uniqueFans(pageFans);
        for (let chunk = 0; chunk * HUB_HISTORY_MAX_FANS < fans.length; chunk += 1) {
          const part = fans.slice(chunk * HUB_HISTORY_MAX_FANS, (chunk + 1) * HUB_HISTORY_MAX_FANS);
          const key = baseKey === undefined ? deps.randomUUID() : hubChunkIdempotencyKey(baseKey, pageLabel, chunk);
          try {
            const response = await client.agentHistoryRequestCreate({
              params: { pageLabel },
              body: { fans: part, depth, reason, idempotencyKey: key },
            });
            requests.push({
              pageLabel,
              chunk,
              fans: part.length,
              ok: true,
              disposition: response.disposition,
              request: response.request,
            });
          } catch (error) {
            failed += 1;
            requests.push({ pageLabel, chunk, fans: part.length, ok: false, error: compositeError(error) });
          }
        }
      }
      return new HubCompositeResult({ requests }, failed, {
        calls: requests.length,
        failed,
        pages: byPage.size,
      });
    },
  },
  {
    name: "history-status",
    operation: "agentHistoryRequestGet",
    summary:
      "One history request: counts, reads, ETA, why it waits, and a page of its fans. With --wait it is"
      + " COMPOSITE: polls until the request is done or cancelled and prints only the last answer.",
    options: {
      request: { kind: "string", describe: "The request ref (uuid; required)" },
      state: { kind: "string", describe: "Only fans in this state (refused | queued | loading | ready | blocked | cancelled)" },
      ...PAGING_OPTIONS,
      wait: { kind: "boolean", describe: "Poll until the request is done or cancelled (each poll is one call)" },
      "poll-seconds": { kind: "number", describe: `Seconds between polls with --wait (at least ${HISTORY_MIN_POLL_SECONDS}, default 30)` },
      "max-wait-seconds": {
        kind: "number",
        describe: "Stop waiting after this long and print the last answer (default 7200)",
      },
    },
    run: async (client, values, deps) => {
      const input = {
        params: { requestRef: requireString(values, "request") },
        query: defined({
          state: readEnum(values, "state", agentHistoryItemStateEnum.options),
          limit: readNumber(values, "limit"),
          cursor: readString(values, "cursor"),
        }),
      };
      if (!readFlag(values, "wait")) {
        return client.agentHistoryRequestGet(input);
      }
      if (input.query.cursor !== undefined) {
        throw new HubUsageError("--wait polls the first page; it takes no --cursor");
      }
      const pollSeconds = readNumber(values, "poll-seconds") ?? 30;
      if (pollSeconds < HISTORY_MIN_POLL_SECONDS) {
        throw new HubUsageError(`--poll-seconds must be at least ${HISTORY_MIN_POLL_SECONDS}: every poll spends the key's budget`);
      }
      const maxWaitSeconds = readNumber(values, "max-wait-seconds") ?? 7200;
      if (maxWaitSeconds < 0) {
        throw new HubUsageError("--max-wait-seconds must not be negative");
      }
      const started = deps.now();
      for (let polls = 1; ; polls += 1) {
        const data = await client.agentHistoryRequestGet(input);
        const state: unknown = (data as { request?: { state?: unknown } }).request?.state;
        const finished = state === "done" || state === "cancelled";
        const waitedMs = deps.now() - started;
        if (finished || waitedMs + pollSeconds * MS_PER_SECOND > maxWaitSeconds * MS_PER_SECOND) {
          return new HubCompositeResult(data, 0, {
            calls: polls,
            finished,
            waitedSeconds: Math.trunc(waitedMs / MS_PER_SECOND),
          });
        }
        await deps.sleep(pollSeconds * MS_PER_SECOND);
      }
    },
  },
  {
    name: "history-cancel",
    operation: "agentHistoryRequestCancel",
    summary: "Cancel a history request: its fans stop being read; loaded messages stay. Idempotent.",
    options: {
      request: { kind: "string", describe: "The request ref (uuid; required)" },
      reason: { kind: "string", describe: "Why (the hub stores a digest only)" },
    },
    run: (client, values) => client.agentHistoryRequestCancel({
      params: { requestRef: requireString(values, "request") },
      body: defined({ reason: readString(values, "reason") }),
    }),
  },
  {
    name: "history-list",
    operation: "agentHistoryRequestList",
    summary: "History requests on your pages, newest first, from every requester.",
    options: {
      "page-label": { kind: "string", describe: "Narrow to one page" },
      state: { kind: "string", describe: "open | done | cancelled" },
      ...PAGING_OPTIONS,
    },
    run: (client, values) => client.agentHistoryRequestList({
      query: defined({
        pageLabel: readString(values, "page-label"),
        state: readEnum(values, "state", agentHistoryRequestStateEnum.options),
        limit: readNumber(values, "limit"),
        cursor: readString(values, "cursor"),
      }),
    }),
  },
];

export function findHubCommand(name: string): HubCommand | undefined {
  return HUB_COMMANDS.find((command) => command.name === name);
}
