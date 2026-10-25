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
  agentPublicationCreateBodySchema,
  agentResolveHintEnum,
  agentSenderRoleEnum,
  agentSyncResourceKeyEnum,
  agentThreadsOrderByEnum,
  agentTimelineLaneEnum,
  platformEnum,
  publicationKindSchema,
  publicationMediaTypeSchema,
  publicationStatusSchema,
  publicationUpdateBodySchema,
  sortDirEnum,
  type AgentHistoryDepth,
  type AgentHistoryFanRef,
  type AgentThreadAvailabilityCause,
  type AgentThreadAvailabilityResponse,
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
 * THE COMPOSITES THAT EXIST: `history-request-batch` (one create per page and
 * 1000 fans) is marked `composite: true` and says COMPOSITE in its summary;
 * `history-request` turns composite on its own when its fans span several
 * pages or more than 1000 (plan §4.1: the CLI splits a big or multi-page list
 * into per-page requests itself), and `history-status --wait` polls one request
 * until it ends. Each makes several calls of ONE documented operation and
 * nothing else, so the evidence envelope of every call is still the
 * operation's own.
 *
 * A NOTED ANSWER: `thread-availability` returns its validated response with a
 * one-line `note` beside it ({@link HubNotedResult}), because its null episode
 * reads too easily as "the chat is served"; on a hub without the route it
 * answers `data: null` and a note saying the state is unknown.
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

/**
 * An answer with one line for whoever reads it, printed as the document's
 * `note`: for a command whose bare `data` is easy to misread (`thread-
 * availability`'s null episode is not "the chat is served"), or whose `data`
 * is null because the hub could not answer and the command knows why.
 */
export class HubNotedResult {
  constructor(
    readonly data: unknown,
    readonly note: string,
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

/**
 * `history-request`'s list file: a fan per line (of `--page-label`), or
 * `pageLabel<TAB>fan` for a fan of its own page; both may mix in one file.
 * Blank lines and `#` comments are skipped. `pageLabel` is null on a line that
 * names no page.
 */
export function parseHubRequestFile(text: string): Array<{ pageLabel: string | null; fan: AgentHistoryFanRef }> {
  const entries: Array<{ pageLabel: string | null; fan: AgentHistoryFanRef }> = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    const tab = rawLine.indexOf("\t");
    if (tab < 0) {
      entries.push({ pageLabel: null, fan: parseHubFanRef(line) });
      return;
    }
    const pageLabel = rawLine.slice(0, tab).trim();
    const ref = rawLine.slice(tab + 1).trim();
    if (pageLabel === "" || ref === "") {
      throw new HubUsageError(`--file line ${index + 1}: expected a fan or pageLabel<TAB>fan`);
    }
    entries.push({ pageLabel, fan: parseHubFanRef(ref) });
  });
  return entries;
}

/**
 * Several history requests, one per page and per {@link HUB_HISTORY_MAX_FANS}
 * fans (plan §4.1: the CLI splits a big or multi-page list itself). A refused
 * request is listed with its metadata and never stops the rest; with a base
 * idempotency key every chunk derives its own, so a re-run files nothing twice.
 */
async function fileHistoryRequests(
  client: KernelClient,
  deps: HubRunDeps,
  byPage: ReadonlyMap<string, readonly AgentHistoryFanRef[]>,
  input: { depth: AgentHistoryDepth; reason: string; baseKey: string | undefined; extra: Record<string, unknown> },
): Promise<HubCompositeResult> {
  const requests: Array<Record<string, unknown>> = [];
  let failed = 0;
  for (const [pageLabel, fans] of byPage) {
    for (let chunk = 0; chunk * HUB_HISTORY_MAX_FANS < fans.length; chunk += 1) {
      const part = fans.slice(chunk * HUB_HISTORY_MAX_FANS, (chunk + 1) * HUB_HISTORY_MAX_FANS);
      const key = input.baseKey === undefined
        ? deps.randomUUID()
        : hubChunkIdempotencyKey(input.baseKey, pageLabel, chunk);
      try {
        const response = await client.agentHistoryRequestCreate({
          params: { pageLabel },
          body: { fans: part, depth: input.depth, reason: input.reason, idempotencyKey: key, ...input.extra },
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
}

// --- thread availability (arena "vanished chat", plan §5) -------------------

/** The code of every 404 the plane itself produces (`staticNotFound`, the
 *  page-scope middleware): a page outside the grant or none at all, a thread
 *  the page does not hold. */
const HUB_PLANE_NOT_FOUND_CODE = "not_found";

/** `thread-availability` against a hub built before its route. */
export const HUB_THREAD_AVAILABILITY_UNKNOWN = "state unknown: the server has no availability route";

/** What a null episode means, word for word. */
export const HUB_THREAD_AVAILABILITY_NONE =
  "no open episode recorded: not proof that Fansly serves the chat (an episode opens only when Fansly refuses a read"
  + " of the chat's messages)";

/** The cause as a reader takes it (plan §8): a likelihood, never a proof. */
const HUB_THREAD_AVAILABILITY_CAUSES: Record<AgentThreadAvailabilityCause, string> = {
  unchecked: "cause not checked: the fan deleted the account or blocked the page",
  probably_blocked: "the account exists (checked without a login): the fan probably blocked the page",
  probably_deleted: "the account was not found on Fansly (checked without a login): probably deleted",
};

/**
 * A 404 that is not the plane's: a hub older than a route answers a path it
 * has no route for from its router (`Not Found`, or a proxy's page with no
 * code at all), while every 404 the plane produces carries `not_found`.
 */
export function hubRouteMissing(error: unknown): boolean {
  return error instanceof KernelApiError && error.status === 404 && error.code !== HUB_PLANE_NOT_FOUND_CODE;
}

/** The episode in one line: the `note` of a `thread-availability` answer. */
export function hubThreadAvailabilityNote(data: AgentThreadAvailabilityResponse): string {
  const episode = data.episode;
  if (!episode) {
    return HUB_THREAD_AVAILABILITY_NONE;
  }
  const refusals = `${episode.refusals} ${episode.refusals === 1 ? "refusal" : "refusals"}`;
  const parts = episode.state === "established"
    ? [
      `established: Fansly does not serve this chat to the page since ${episode.openedAt} (${refusals}`
        + `${episode.establishedAt === null ? "" : `, established ${episode.establishedAt}`},`
        + ` the last ${episode.lastRefusalAt})`,
      ...(episode.retryNotBefore === null
        ? []
        : [`nothing reads it before ${episode.retryNotBefore}, then only a new message in the chat asks for one read`]),
    ]
    : [
      `refusing: Fansly has refused this chat to the page since ${episode.openedAt} (${refusals},`
        + ` the last ${episode.lastRefusalAt})`,
      "not established yet",
    ];
  parts.push(HUB_THREAD_AVAILABILITY_CAUSES[episode.cause]);
  if (episode.ownerNote !== null) {
    parts.push(`the owner's note (${episode.ownerNote.at}): ${episode.ownerNote.text}`);
  }
  return parts.join("; ");
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

// --- publications (wall posts, docs/plans/2026-10-23-wall-posts) -----------------

const PUBLICATION_CAPABILITY_HINT =
  "This key lacks write:publication_drafts: the owner grants it to the key (dashboard, Settings, agent keys).";

function publicationHint(error: { status: number | null; code: string | null }): string | null {
  return error.code === "agent_capability_missing" ? PUBLICATION_CAPABILITY_HINT : null;
}

/** What a draft body says (publicationContentSchema), besides its media. */
const PUBLICATION_CONTENT_KEYS = new Set([
  "kind", "text", "media", "previews", "publishAt", "expiresAt", "wallRefs", "tierRefs", "priceMills", "repost",
]);

/**
 * The keys of a publication as `publication-get` prints it that a draft body
 * does not take: dropped, so that answer can be edited and sent back (an edit
 * keeps `version`, see `extraKeys`). Any other unknown key is refused, so a
 * misspelt field never silently resets to its default.
 */
const PUBLICATION_READ_ONLY_KEYS = new Set([
  "id", "version", "pageLabel", "platform", "status", "findings", "blocked", "author", "approvedRevisionId",
  "platformPostRef", "statusReason", "previousPublicationId", "createdAt", "updatedAt", "statusChangedAt",
  "events", "revision",
]);

type HubPublicationMediaInput = { source: "vault"; mediaRef: string } | { source: "file"; fileId: number };

/** `vault:<mediaRef>` (or a bare media ref) for a file of the page's vault, `file:<id>` for an uploaded one. */
export function parseHubPublicationMedia(raw: string): HubPublicationMediaInput {
  const value = raw.trim();
  if (value.startsWith("file:")) {
    const fileId = Number(value.slice("file:".length));
    if (!Number.isSafeInteger(fileId) || fileId <= 0) {
      throw new HubUsageError(`a file must look like file:<id>, got "${raw}"`);
    }
    return { source: "file", fileId };
  }
  const mediaRef = value.startsWith("vault:") ? value.slice("vault:".length) : value;
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(mediaRef)) {
    throw new HubUsageError(`a vault file must look like vault:<mediaRef>, got "${raw}"`);
  }
  return { source: "vault", mediaRef };
}

/** A media item of a draft file: the body's own shape, or `publication-get`'s (with `role`). */
function draftFileMedia(item: unknown, where: string): { role: string | null; position: number; media: HubPublicationMediaInput } {
  if (typeof item !== "object" || item === null) {
    throw new HubUsageError(`--file ${where}: a media item must be an object`);
  }
  const entry = item as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role : null;
  const position = typeof entry.position === "number" ? entry.position : 0;
  if (entry.source === "file" && typeof entry.fileId === "number") {
    return { role, position, media: { source: "file", fileId: entry.fileId } };
  }
  if (entry.source === "vault" && typeof entry.mediaRef === "string") {
    return { role, position, media: { source: "vault", mediaRef: entry.mediaRef } };
  }
  throw new HubUsageError(`--file ${where}: a media item is {source: "vault", mediaRef} or {source: "file", fileId}`);
}

/**
 * A draft body from a JSON file: the body itself, or the answer of
 * `publication-get` (the whole printed document or its `data`), whose media
 * list carries `role` and is split back into `media` and `previews` here.
 */
export function parseHubDraftFile(text: string, extraKeys: readonly string[]): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HubUsageError("--file is not JSON");
  }
  if (typeof parsed === "object" && parsed !== null && "ok" in parsed && "data" in parsed) {
    parsed = (parsed as { data: unknown }).data;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HubUsageError("--file must hold a JSON object (a draft body)");
  }
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (PUBLICATION_CONTENT_KEYS.has(key) || extraKeys.includes(key)) {
      body[key] = value;
    } else if (!PUBLICATION_READ_ONLY_KEYS.has(key)) {
      throw new HubUsageError(`--file: "${key}" is not a field of a draft`);
    }
  }
  for (const key of ["media", "previews"] as const) {
    const list = body[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new HubUsageError(`--file: "${key}" must be a list`);
    const items = list.map((item, index) => draftFileMedia(item, `${key}[${index}]`));
    if (key === "media" && items.some((item) => item.role !== null)) {
      const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;
      body.media = items.filter((item) => item.role !== "preview").sort(byPosition).map((item) => item.media);
      body.previews = items.filter((item) => item.role === "preview").sort(byPosition).map((item) => item.media);
    } else {
      body[key] = items.map((item) => item.media);
    }
  }
  return body;
}

/**
 * The draft a create or an edit sends: `--file` first, then every flag given
 * on top of it. The result is checked against the contract here, so a bad
 * body is a usage error that names the field before any call.
 */
function draftBody(values: HubOptionValues, deps: HubRunDeps, extraKeys: readonly string[]): Record<string, unknown> {
  const path = readString(values, "file");
  const fromFile = path === undefined ? {} : parseHubDraftFile(readTextFile(deps, path), extraKeys);
  const text = readString(values, "text");
  const textFile = readString(values, "text-file");
  if (text !== undefined && textFile !== undefined) {
    throw new HubUsageError("give the text once: --text or --text-file");
  }
  const priceMills = readNumber(values, "price-mills");
  if (priceMills !== undefined && !Number.isSafeInteger(priceMills)) {
    throw new HubUsageError("--price-mills must be a whole number of mills (1000 = $1)");
  }
  const expiresAt = readString(values, "expires-at");
  return {
    ...fromFile,
    ...defined({
      kind: readEnum(values, "kind", publicationKindSchema.options),
      text: textFile === undefined ? text : readTextFile(deps, textFile),
      media: readList(values, "media")?.map(parseHubPublicationMedia),
      previews: readList(values, "preview")?.map(parseHubPublicationMedia),
      publishAt: readString(values, "publish-at"),
      expiresAt: expiresAt === "none" ? null : expiresAt,
      wallRefs: readList(values, "wall"),
      tierRefs: readList(values, "tier"),
      priceMills,
      repost: readTristate(values, "repost"),
    }),
  };
}

/** The contract's own check of an assembled body, as a usage error naming each field. */
function checkedDraft<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`);
    throw new HubUsageError(`the draft is not valid: ${issues.join("; ")}`);
  }
  return result.data;
}

function requireId(values: HubOptionValues, name: string): number {
  const value = readNumber(values, name);
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new HubUsageError(`--${name} is required (a positive integer)`);
  }
  return value;
}

const DRAFT_OPTIONS: Record<string, HubOption> = {
  file: {
    kind: "string",
    describe: "A JSON draft body, or a publication as publication-get prints it; the flags below override its fields",
  },
  kind: { kind: "string", describe: "fyp_post (Fansly) | subscriber_post | paid_post | story" },
  text: { kind: "string", describe: "The post text (or --text-file)" },
  "text-file": { kind: "string", describe: "A file with the post text" },
  media: { kind: "list", describe: "A file, in order (repeatable): vault:<mediaRef> from publication-media, or file:<id>" },
  preview: { kind: "list", describe: "A preview of a post with a price (repeatable), like --media" },
  "publish-at": { kind: "string", describe: "When it goes out, RFC 3339 with an explicit offset" },
  "expires-at": { kind: "string", describe: "When it leaves the wall (RFC 3339), or none" },
  wall: { kind: "list", describe: "A Fansly wall ref (repeatable); none named: the page's default wall" },
  tier: { kind: "list", describe: "A Fansly subscription tier that sees a subscriber post (repeatable; several: any of them); none: every subscriber" },
  "price-mills": { kind: "number", describe: "A paid post's price, or on a Fansly subscriber post what anyone else pays to see it, in MILLS: 1000 = $1, so $9.99 is 9990" },
  repost: { kind: "tristate", describe: "true: the file goes out again on purpose (\"перезалив\")" },
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
    name: "thread-availability",
    operation: "agentThreadAvailability",
    summary:
      "Whether Fansly stopped serving ONE chat to its page: the chat's open unavailability episode, or null (no open"
      + " episode recorded, not proof that Fansly serves the chat); `note` says it in one line. No message text;"
      + " needs read:messages. On a hub without the route: state unknown, exit 0.",
    options: {
      "page-label": { kind: "string", describe: "Page holding the thread (required)" },
      conversation: { kind: "string", describe: "Native conversation ref (required)" },
    },
    run: async (client, values) => {
      const input = {
        params: {
          pageLabel: requireString(values, "page-label"),
          conversationRef: requireString(values, "conversation"),
        },
      };
      try {
        const data = await client.agentThreadAvailability(input);
        return new HubNotedResult(data, hubThreadAvailabilityNote(data));
      } catch (error) {
        // A hub older than the route cannot say (plan §5): no error of this
        // call, an unknown state — said so, exit 0. A page or a thread out of
        // reach is the plane's own 404 and stays an error.
        if (hubRouteMissing(error)) {
          return new HubNotedResult(null, HUB_THREAD_AVAILABILITY_UNKNOWN);
        }
        throw error;
      }
    },
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
      "File a history request: fans of one page and a depth. More than 1000 fans, or a --file whose"
      + " pageLabel<TAB>fan lines name several pages, are split here into one request per page and per 1000 fans"
      + " (then COMPOSITE: several calls, one result per request). Works on pages switched to the Fansly Sync"
      + " Engine; elsewhere the hub answers 409 and the document carries the hydration fallback.",
    options: {
      "page-label": {
        kind: "string",
        describe: "The page whose chats to read (required unless every --file line names its own page)",
      },
      fan: { kind: "list", describe: "A fan's Fansly account id (repeatable)" },
      conversation: { kind: "list", describe: "A chat's conversation ref (repeatable)" },
      "chat-url": { kind: "list", describe: "A chat link https://fansly.com/messages/<id> (repeatable)" },
      file: {
        kind: "string",
        describe: "A file with one fan per line: account id, chat link, or conversation:<ref>;"
          + " a line pageLabel<TAB>fan names its own page",
      },
      ...HISTORY_FILING_OPTIONS,
      ...CLAIM_OPTION,
    },
    hint: historyHint,
    run: (client, values, deps) => {
      const pageLabel = readString(values, "page-label");
      const path = readString(values, "file");
      const pageOf = (): string => {
        if (pageLabel === undefined || pageLabel === "") {
          throw new HubUsageError(
            "--page-label is required for --fan, --conversation, --chat-url and --file lines without pageLabel<TAB>",
          );
        }
        return pageLabel;
      };
      // Pages in first-seen order: the flags' page first, then the file's.
      const byPage = new Map<string, AgentHistoryFanRef[]>();
      const add = (label: string, fan: AgentHistoryFanRef) => {
        const fans = byPage.get(label) ?? [];
        fans.push(fan);
        byPage.set(label, fans);
      };
      for (const platformUserId of readList(values, "fan") ?? []) add(pageOf(), { kind: "fan", platformUserId });
      for (const conversationRef of readList(values, "conversation") ?? []) {
        add(pageOf(), { kind: "conversation", conversationRef });
      }
      for (const url of readList(values, "chat-url") ?? []) add(pageOf(), { kind: "chat_url", url });
      for (const entry of path === undefined ? [] : parseHubRequestFile(readTextFile(deps, path))) {
        add(entry.pageLabel ?? pageOf(), entry.fan);
      }
      for (const [label, fans] of byPage) byPage.set(label, uniqueFans(fans));
      if (byPage.size === 0) {
        throw new HubUsageError("name at least one fan: --fan, --conversation, --chat-url or --file");
      }
      const depth = historyDepth(values);
      const reason = requireString(values, "reason");
      const key = readIdempotencyKey(values);
      const [only, ...others] = byPage;
      if (only !== undefined && others.length === 0 && only[1].length <= HUB_HISTORY_MAX_FANS) {
        // One page, at most 1000 fans: one call, the operation's own document.
        return client.agentHistoryRequestCreate({
          params: { pageLabel: only[0] },
          body: { fans: only[1], depth, reason, idempotencyKey: key ?? deps.randomUUID(), ...claimBody(values) },
        });
      }
      return fileHistoryRequests(client, deps, byPage, { depth, reason, baseKey: key, extra: claimBody(values) });
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
      for (const [label, fans] of byPage) byPage.set(label, uniqueFans(fans));
      return fileHistoryRequests(client, deps, byPage, {
        depth: historyDepth(values),
        reason: requireString(values, "reason"),
        baseKey: readIdempotencyKey(values),
        extra: {},
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
  {
    name: "sync-status",
    operation: "agentSyncStatus",
    summary:
      "The Fansly Sync Engine's status of your pages: pause record, sends by class, queue by why it waits,"
      + " holds, request progress.",
    options: {
      "page-label": { kind: "string", describe: "Narrow to one page" },
    },
    run: (client, values) => client.agentSyncStatus({
      query: defined({ pageLabel: readString(values, "page-label") }),
    }),
  },
  {
    name: "sync-why",
    operation: "agentSyncWhy",
    summary: "Why a page's engine work of one resource (and subject) is waiting.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      resource: { kind: "string", describe: "A registry key, e.g. dm-messages.head (required)" },
      subject: { kind: "string", describe: "A chat, fan, media … id; omitted: every open row of the key" },
    },
    run: (client, values) => client.agentSyncWhy({
      params: { pageLabel: requireString(values, "page-label") },
      query: {
        resource: requireEnum(values, "resource", agentSyncResourceKeyEnum.options),
        ...defined({ subject: readString(values, "subject") }),
      },
    }),
  },
  {
    name: "publication-media",
    operation: "agentPublicationMedia",
    summary:
      "The page's media a draft can use, newest first: type, size, duration, when each file last went out on the"
      + " page and the live publication that uses it, and whether a draft at --publish-at would be a repeat."
      + " Needs write:publication_drafts.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      type: { kind: "string", describe: "image | video | audio" },
      "publish-at": {
        kind: "string",
        describe: "The time you plan to post at (default now); repeats and the nearest publication are measured from it",
      },
      ...PAGING_OPTIONS,
    },
    hint: publicationHint,
    run: (client, values) => client.agentPublicationMedia({
      params: { pageLabel: requireString(values, "page-label") },
      query: defined({
        type: readEnum(values, "type", publicationMediaTypeSchema.options),
        publishAt: readString(values, "publish-at"),
        limit: readNumber(values, "limit"),
        cursor: readString(values, "cursor"),
      }),
    }),
  },
  {
    name: "publication-create",
    operation: "agentPublicationCreate",
    summary:
      "Draft a publication on a page: a person approves it, an agent never can. The body comes from --file and/or"
      + " the flags; the answer carries Hub's findings (blocked: true means it cannot be approved as it is)."
      + " Repeat-safe by --idempotency-key.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      ...DRAFT_OPTIONS,
      "idempotency-key": {
        kind: "string",
        describe: "Required (or idempotencyKey in --file): the same key and body answer the same draft, another body 409",
      },
    },
    hint: publicationHint,
    run: (client, values, deps) => {
      const pageLabel = requireString(values, "page-label");
      const body = draftBody(values, deps, ["idempotencyKey"]);
      const key = readString(values, "idempotency-key") ?? body.idempotencyKey;
      if (typeof key !== "string" || key === "") {
        throw new HubUsageError("--idempotency-key is required: it makes the create repeat-safe");
      }
      return client.agentPublicationCreate({
        params: { pageLabel },
        body: checkedDraft(agentPublicationCreateBodySchema, { ...body, idempotencyKey: key }),
      });
    },
  },
  {
    name: "publication-list",
    operation: "agentPublicationList",
    summary: "The page's publications by publish time: status, findings, author. Needs write:publication_drafts.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      status: { kind: "string", describe: `Only this status (${publicationStatusSchema.options.join(" | ")})` },
      ...WINDOW_OPTIONS,
      limit: { kind: "number", describe: "Maximum publications (default 500)" },
    },
    hint: publicationHint,
    run: (client, values) => client.agentPublicationList({
      params: { pageLabel: requireString(values, "page-label") },
      query: defined({
        status: readEnum(values, "status", publicationStatusSchema.options),
        from: readString(values, "from"),
        to: readString(values, "to"),
        limit: readNumber(values, "limit"),
      }),
    }),
  },
  {
    name: "publication-get",
    operation: "agentPublicationGet",
    summary: "One publication of your pages: a draft's findings re-checked now, and its status journal.",
    options: {
      id: { kind: "number", describe: "The publication id (required)" },
    },
    hint: publicationHint,
    run: (client, values) => client.agentPublicationGet({ params: { id: requireId(values, "id") } }),
  },
  {
    name: "publication-edit",
    operation: "agentPublicationUpdate",
    summary:
      "Replace a draft this key wrote with a whole new body (--file, e.g. publication-get's answer edited, and/or"
      + " flags). Fields left out reset to their defaults. An approved one returns to draft and is approved again.",
    options: {
      id: { kind: "number", describe: "The publication id (required)" },
      version: {
        kind: "number",
        describe: "The version you edited (or version in --file); a newer one on the hub is 409",
      },
      ...DRAFT_OPTIONS,
    },
    hint: publicationHint,
    run: (client, values, deps) => {
      const id = requireId(values, "id");
      const body = draftBody(values, deps, ["version"]);
      const version = readNumber(values, "version") ?? body.version;
      if (typeof version !== "number") {
        throw new HubUsageError("--version is required: the version you edited");
      }
      return client.agentPublicationUpdate({
        params: { id },
        body: checkedDraft(publicationUpdateBodySchema, { ...body, version }),
      });
    },
  },
];

export function findHubCommand(name: string): HubCommand | undefined {
  return HUB_COMMANDS.find((command) => command.name === name);
}
