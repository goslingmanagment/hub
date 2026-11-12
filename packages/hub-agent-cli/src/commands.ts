import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  AGENT_CLAIM_FIELDS,
  AGENT_REPORT_SECTIONS,
  agentCoverageStatusEnum,
  agentCrossSpendersAudienceEnum,
  agentDatasetEnum,
  agentFanWatchBodySchema,
  agentSaleContextBodySchema,
  agentDatasetFilterOpEnum,
  agentHistoryItemStateEnum,
  agentHistoryRequestStateEnum,
  agentMessageDirectionEnum,
  agentObservationSourceEnum,
  agentPublicationCreateBodySchema,
  agentReportPutBodySchema,
  agentFanQueueAppendBodySchema,
  agentFanQueueCreateBodySchema,
  agentFanQueuePreviewBodySchema,
  agentFanQueueUpdateBodySchema,
  agentMatterCloseBodySchema,
  agentMatterCommentBodySchema,
  agentMatterOpenBodySchema,
  agentCustomCardsBodySchema,
  agentCustomOrderCreateBodySchema,
  agentCustomOrderUpdateBodySchema,
  CUSTOM_ORDER_STATES,
  agentShiftReportCommentBodySchema,
  agentShiftReportLineBodySchema,
  agentShiftReportOffPlatformBodySchema,
  agentShiftReportSubmitBodySchema,
  SHIFT_REPORT_COMMENT_MAX,
  SHIFT_REPORT_NOTE_MAX,
  SHIFT_REPORT_STATEMENTS,
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
  millsFromDollars,
  MATTER_CLOSED_HOWS,
  MATTER_OWNER_ROLE_NAMES,
  matterKindOfKey,
  type AgentCrossSpendersResponse,
  type AgentHistoryDepth,
  type AgentHistoryFanRef,
  type AgentThreadAvailabilityCause,
  type AgentThreadAvailabilityResponse,
} from "@agency_hub_core/contracts";
import { formatUsdFromMills, PUBLICATION_VAULT_ALBUM_MEDIA_MAX, PUBLICATION_VAULT_ALBUM_TITLE_MAX } from "@agency_hub_core/shared";
import { KernelApiError, type KernelClient, type KernelOperationResponse } from "@kernel/sdk";

import {
  checkHubFile,
  formatHubBytes,
  hashHubFiles,
  hubFilesHeld,
  hubFileTwins,
  readHubAlbumFolder,
  sendHubFiles,
  type HubAlbumFolder,
  type HubFileLookup,
  type HubFileRef,
  type HubFileUpload,
  type HubHashedItem,
  type HubLocalFiles,
  type HubUploadItem,
  type HubUploadOutcome,
} from "./upload.ts";

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
 * `cross-spenders --all` is composite the same way: it follows the operation's
 * own cursors and prints the whole set once (its consumers need every fan).
 *
 * TWO COMPOSITES READ LOCAL FILES: `publication-file-upload` streams files
 * from disk into Hub, one upload per file (the one body the SDK cannot send,
 * see upload.ts), and `vault-album-draft` does that for a pack's folder and
 * then drafts the album. Both check the key and the page first with
 * `agentPublicationTargets`, so a wrong page costs no upload, then ask
 * `agentPublicationFileLookup` which of the files' bytes Hub holds, and send
 * only the others; the album also makes one `agentPublicationCreate`. They
 * take their paths as bare words.
 *
 * `media-look` and `media-look-get` WRITE LOCAL FILES with `--out DIR`: a
 * look's frames as JPEGs under DIR, the printed answer naming their paths in
 * place of the base64. While a look is `queued`, `media-look` reads it again
 * with `agentMediaLookGet` (`--wait`, nothing new is fetched by that).
 *
 * A NOTED ANSWER: `thread-availability` returns its validated response with a
 * one-line `note` beside it ({@link HubNotedResult}), because its null episode
 * reads too easily as "the chat is served"; on a hub without the route it
 * answers `data: null` and a note saying the state is unknown. So does
 * `publication-withdraw` when Fansly's answer is `accepted` (not withdrawn
 * yet), and `publication-queue --refresh`, which first asks
 * `agentPublicationQueueRefresh` for a fresh read (the owner's «Обновить») and
 * then prints the last read, its own operation's answer, saying so. So do
 * `post-withdraw` and `post-delete` when the answer is `accepted` (not done
 * yet: ask again) or `unknown` (not done: tell the owner).
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

/** A flag was missing, repeated, or carried a value the contract cannot use; `details` lists what, when one line cannot. */
export class HubUsageError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

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

// The help adds each operation's own `limit` bounds and window rule to these
// texts (contract.ts, hubOptionHelp): the numbers stay in the contract.
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
  /** Local files to upload: their kind, size and first bytes, a folder's names. */
  files: HubLocalFiles;
  /** One attempt to stream one file into Hub (the only body the SDK cannot send). */
  upload: HubFileUpload;
  /** A line for whoever watches a long call (stderr); never part of the document. */
  progress(line: string): void;
  /** Write one file, its folders made as needed (`media-look --out`). */
  writeFile(path: string, bytes: Uint8Array): void;
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
  /** One command line that works, shown by `--help`. */
  example?: string;
  options: Record<string, HubOption>;
  /** Several calls of `operation` (see the header). */
  composite?: true;
  /** A next step to print beside a refusal this command expects. */
  hint?(error: { status: number | null; code: string | null }): string | null;
  /**
   * Bare words after the command, for the commands that take local paths
   * (a shell glob expands into them). Every other command refuses a bare word:
   * it would be a flag's value silently ignored.
   */
  arguments?: { name: string; describe: string; min: number; max: number | null };
  run(client: KernelClient, values: HubOptionValues, deps: HubRunDeps, args: readonly string[]): Promise<unknown>;
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

/** A JSON body from --file. */
function readJsonFile(deps: HubRunDeps, path: string): unknown {
  try {
    return JSON.parse(readTextFile(deps, path));
  } catch (error) {
    if (error instanceof HubUsageError) throw error;
    throw new HubUsageError(`--file ${path} is not JSON`);
  }
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
  return uuidOf(`${base.toLowerCase()}\u0000${pageLabel}\u0000${chunk}`);
}

/** A version-4-shaped uuid that is a function of `text`. */
function uuidOf(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
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

// --- cross-page spenders (the excluded list of a mass message) ---------------

/** At most this many calls per `cross-spenders --all` (200 fans each). */
export const HUB_CROSS_SPENDERS_MAX_CALLS = 100;
const HUB_CROSS_SPENDERS_PAGE = 200;

/** A dollar flag as whole mills (1000 = $1), through the money codec:
 *  `positive` refuses 0, otherwise only a negative amount is refused. */
function hubDollarsToMills(values: HubOptionValues, name: string, bound: "positive" | "non_negative"): number | undefined {
  const raw = readString(values, name);
  if (raw === undefined) return undefined;
  let mills: bigint;
  try {
    mills = millsFromDollars(raw);
  } catch {
    throw new HubUsageError(`--${name} takes dollars (20 or 20.50), got "${raw}"`);
  }
  const value = Number(mills);
  if (!Number.isSafeInteger(value) || value < (bound === "positive" ? 1 : 0)) {
    throw new HubUsageError(`--${name} must be ${bound === "positive" ? "more than 0" : "0 or more"} dollars, got "${raw}"`);
  }
  return value;
}

/** `--source lora-2,ari-1` or repeated, `all`, or absent (the model's other pages). */
function crossSpendersSources(values: HubOptionValues): string[] | undefined {
  const raw = readList(values, "source");
  if (raw === undefined) return undefined;
  const labels = [...new Set(raw.flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value !== ""))];
  if (labels.length === 0) throw new HubUsageError("--source takes page labels or all");
  if (labels.length > 1 && (labels.includes("all") || labels.includes("model"))) {
    throw new HubUsageError("--source is all, or page labels, never both");
  }
  return labels;
}

/**
 * Every page of a cross-spenders traversal, as one document: the first
 * answer's scope, summary and capture, every fan once (a fan whose spend moved
 * between two calls can come back: the first copy stays), each call's
 * delivery and conclusion, and the union of their blockers as `conclusion`.
 */
async function crossSpendersAll(
  client: KernelClient,
  first: AgentCrossSpendersResponse,
  pageLabel: string,
): Promise<HubCompositeResult> {
  const responses = [first];
  let truncated = false;
  for (let next = first.delivery.nextCursor; next !== null; ) {
    if (responses.length >= HUB_CROSS_SPENDERS_MAX_CALLS) {
      truncated = true;
      break;
    }
    const response = await client.agentCrossSpenders({ params: { pageLabel }, query: { cursor: next } });
    responses.push(response);
    next = response.delivery.nextCursor;
  }
  const seen = new Set<string>();
  const items = responses.flatMap((response) => response.items).filter((item) => {
    if (seen.has(item.platformUserId)) return false;
    seen.add(item.platformUserId);
    return true;
  });
  const returned = responses.reduce((sum, response) => sum + response.items.length, 0);
  const blockers = [...new Set(responses.flatMap((response) => response.conclusion.blockers))];
  return new HubCompositeResult({
    scope: first.scope,
    summary: first.summary,
    items,
    capture: first.capture,
    conclusion: { blockers },
    calls: responses.map((response) => ({ delivery: response.delivery, conclusion: response.conclusion })),
  }, truncated ? 1 : 0, {
    calls: responses.length,
    items: items.length,
    duplicatesDropped: returned - items.length,
    ...(truncated ? { truncated: `stopped after ${HUB_CROSS_SPENDERS_MAX_CALLS} calls` } : {}),
  });
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
  "This key lacks write:publication_drafts (to draft) or approve:publications / approve:vault_albums (to approve): the owner grants it to the key"
  + " (dashboard, Settings, agent keys).";

function publicationHint(error: { status: number | null; code: string | null }): string | null {
  return error.code === "agent_capability_missing" ? PUBLICATION_CAPABILITY_HINT : null;
}

const WITHDRAW_CAPABILITY_HINT =
  "This key lacks withdraw:publications (to take a post off the schedule; it also reads the page's schedule, as"
  + " write:publication_drafts does): the owner grants it to the key (dashboard, Settings, agent keys).";

function withdrawHint(error: { status: number | null; code: string | null }): string | null {
  return error.code === "agent_capability_missing" ? WITHDRAW_CAPABILITY_HINT : null;
}

const DELETE_CAPABILITY_HINT =
  "This key lacks delete:posts (to delete a published post, only on the owner's «да» for that post): the owner grants"
  + " it to the key (dashboard, Settings, agent keys).";

function deleteHint(error: { status: number | null; code: string | null }): string | null {
  return error.code === "agent_capability_missing" ? DELETE_CAPABILITY_HINT : null;
}

const POST_ACCEPTED_NOTE =
  "Accepted is not done yet: Hub queued ONE command on the page's engine (a cancel goes once a fresh read of the"
  + " schedule still shows the post; a delete is checked by reading the post after Fansly's answer). Ask the same"
  + " command again in a minute or two: it sends nothing and answers where the command stands.";

const POST_UNKNOWN_NOTE =
  "Unknown is NOT done: Hub does not know whether the platform did it, and never sends it again. Tell the owner at"
  + " once (the post, why, `check`); do not report it as done.";

/** `post-withdraw`'s and `post-delete`'s answer, with a note when it is not an end. */
function notedPostAnswer<T extends { outcome: string }>(answer: T): T | HubNotedResult {
  if (answer.outcome === "accepted") return new HubNotedResult(answer, POST_ACCEPTED_NOTE);
  if (answer.outcome === "unknown") return new HubNotedResult(answer, POST_UNKNOWN_NOTE);
  return answer;
}

const PUBLICATION_WITHDRAW_ACCEPTED_NOTE =
  "Accepted is not withdrawn yet: Hub sends the cancel once a fresh read of the schedule still shows the post, then"
  + " reads again. Follow it with publication-get: withdrawn, unknown (a person checks Fansly) or still scheduled"
  + " with the withdrawal rejected.";

// --- media looks (look:media) ----------------------------------------------

/** How long `media-look` keeps reading a queued look by default, and at most. */
const MEDIA_LOOK_WAIT_SECONDS = 60;
const MEDIA_LOOK_WAIT_MAX_SECONDS = 600;
/** Seconds between two reads of a queued look (each read is one call, nothing is fetched). */
const MEDIA_LOOK_POLL_SECONDS = 5;

const MEDIA_LOOK_CAPABILITY_HINT =
  "This key lacks look:media (frames of the page's own media): the owner grants it to the key (dashboard, Settings,"
  + " agent keys).";

function mediaLookHint(error: { status: number | null; code: string | null }): string | null {
  switch (error.code) {
    case "agent_capability_missing":
      return MEDIA_LOOK_CAPABILITY_HINT;
    case "media_look_in_flight":
      return "Another look of this page is still in flight (one at a time per page): read it with media-look-get, then ask again.";
    case "media_look_daily_limit":
      return "The page's looks for today (UTC) are used up: a cached look of a file still answers; otherwise wait for tomorrow or tell the owner.";
    case "media_look_post_not_seen":
      return "Hub looks only at a post it has seen on this page (its schedule or its wall): check --post-ref against publication-queue or the posts dataset.";
    case "media_look_not_in_vault":
      return "That file is in no album of the page's vault as Hub last walked it: look at it through a post (--post-ref) instead.";
    default:
      return null;
  }
}

type MediaLookAnswer = KernelOperationResponse<"agentMediaLookCreate">;

function mediaLookFramesMode(values: HubOptionValues): "inline" | "none" {
  const none = readFlag(values, "no-frames");
  if (none && readString(values, "out") !== undefined) throw new HubUsageError("--out writes the frames: it takes no --no-frames");
  return none ? "none" : "inline";
}

/** A folder or file name from a page label or a ref: nothing but safe characters. */
function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";
}

/** `f000_t00000ms.jpg`: a frame's place in the video; `f000.jpg` for a cover or a photo. */
export function mediaLookFrameFileName(frame: { index: number; atMs: number | null }): string {
  const index = String(frame.index).padStart(3, "0");
  return frame.atMs === null ? `f${index}.jpg` : `f${index}_t${String(frame.atMs).padStart(5, "0")}ms.jpg`;
}

/** `DIR/<page>/<publication-N or post-REF>[-<index>]`: one folder per file of a post; `DIR/<page>/media-REF` for a vault file. */
export function mediaLookFolder(out: string, pageLabel: string, target: MediaLookAnswer["target"]): string {
  if (target.postRef === null && target.publicationId === null) return resolve(out, safeName(pageLabel), `media-${safeName(target.mediaRef ?? "unknown")}`);
  const post = target.publicationId === null ? `post-${safeName(target.postRef ?? "unknown")}` : `publication-${target.publicationId}`;
  return resolve(out, safeName(pageLabel), (target.index ?? 0) === 0 ? post : `${post}-${target.index}`);
}

/** The look as printed: as the hub answered, or — with `--out` — its frames
 *  written under the folder and named by their paths instead of base64. A
 *  look still queued carries a note naming the command that reads it. */
function mediaLookPrinted(look: MediaLookAnswer, pageLabel: string, out: string | undefined, deps: HubRunDeps): unknown {
  let data: unknown = look;
  if (out !== undefined) {
    const folder = mediaLookFolder(out, pageLabel, look.target);
    data = {
      ...look,
      frames: look.frames.map(({ jpegBase64, ...frame }) => {
        if (jpegBase64 === undefined) return frame;
        const path = resolve(folder, mediaLookFrameFileName(frame));
        deps.writeFile(path, Buffer.from(jpegBase64, "base64"));
        return { ...frame, path };
      }),
    };
  }
  return look.status === "queued"
    ? new HubNotedResult(
      data,
      `The page's engine has not answered yet: read it again with hub media-look-get --page-label ${pageLabel} --look-id`
        + ` ${look.lookId}${out === undefined ? "" : ` --out ${out}`}`,
    )
    : data;
}

/** What a draft body says (publicationContentSchema), besides its media. A vault
 *  album's `vaultAlbumRef` stays with it: sent again, its files go into that album. */
const PUBLICATION_CONTENT_KEYS = new Set([
  "kind", "text", "media", "previews", "publishAt", "expiresAt", "wallRefs", "tierRefs", "priceMills", "repost",
  "pinWallRefs", "replyLock", "subscribersOnly", "extraAttachments", "vaultAlbumRef",
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
  "events", "revision", "withdrawal", "deletion", "albumRun",
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

/** A media item of a draft file: the body's own shape, or `publication-get`'s (with `role` and its `attachment`). */
function draftFileMedia(item: unknown, where: string): { role: string | null; position: number; attachment: number; media: HubPublicationMediaInput } {
  if (typeof item !== "object" || item === null) {
    throw new HubUsageError(`--file ${where}: a media item must be an object`);
  }
  const entry = item as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role : null;
  const position = typeof entry.position === "number" ? entry.position : 0;
  const attachment = typeof entry.attachment === "number" ? entry.attachment : 0;
  if (entry.source === "file" && typeof entry.fileId === "number") {
    // The name a draft gave the file (a vault album's card) goes with it into the next draft.
    const name = typeof entry.name === "string" && entry.name.trim() !== "" ? { name: entry.name } : {};
    return { role, position, attachment, media: { source: "file", fileId: entry.fileId, ...name } };
  }
  if (entry.source === "vault" && typeof entry.mediaRef === "string") {
    return { role, position, attachment, media: { source: "vault", mediaRef: entry.mediaRef } };
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
      // `publication-get`'s list: every file of the post with its role and
      // attachment. The post's own go back to `media` / `previews`, an extra
      // attachment's to its own entry of `extraAttachments`.
      const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;
      const of = (attachment: number, preview: boolean) => items
        .filter((item) => item.attachment === attachment && (item.role === "preview") === preview).sort(byPosition).map((item) => item.media);
      body.media = of(0, false);
      body.previews = of(0, true);
      if (Array.isArray(body.extraAttachments)) {
        body.extraAttachments = body.extraAttachments.map((extra, index) => {
          if (typeof extra !== "object" || extra === null) throw new HubUsageError(`--file: extraAttachments[${index}] must be an object`);
          const { attachment, ...rest } = extra as Record<string, unknown>;
          if ("media" in rest) return rest;
          const number = typeof attachment === "number" ? attachment : index + 1;
          return { ...rest, media: of(number, false), previews: of(number, true) };
        });
      }
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
      pinWallRefs: readList(values, "pin-wall"),
      replyLock: readList(values, "reply-lock"),
      subscribersOnly: readTristate(values, "subscribers-only"),
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
  kind: { kind: "string", describe: "fyp_post (Fansly) | subscriber_post | paid_post | story | vault_album (Fansly; --text is the album's title)" },
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
  "pin-wall": { kind: "list", describe: "A Fansly wall to pin the post on (repeatable); one of the post's walls" },
  "reply-lock": { kind: "list", describe: "Who may reply to a Fansly post (repeatable, any of them): followers | subscribers; none: everyone" },
  "subscribers-only": { kind: "tristate", describe: "true: a Fansly paid post only subscribers may buy (of --tier, or of every tier)" },
};

// --- files from disk and vault albums (publication-file-upload, vault-album-draft) ---

const UPLOAD_PARALLEL_DEFAULT = 2;
const UPLOAD_PARALLEL_MAX = 6;
const CREATE_RETRY_DELAYS_MS = [2_000, 10_000];

const UPLOAD_OPTIONS: Record<string, HubOption> = {
  parallel: { kind: "number", describe: `Files sent at once (default ${UPLOAD_PARALLEL_DEFAULT}, at most ${UPLOAD_PARALLEL_MAX})` },
};

function readParallel(values: HubOptionValues): number {
  const parallel = readNumber(values, "parallel") ?? UPLOAD_PARALLEL_DEFAULT;
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > UPLOAD_PARALLEL_MAX) {
    throw new HubUsageError(`--parallel must be a whole number from 1 to ${UPLOAD_PARALLEL_MAX}, got "${String(parallel)}"`);
  }
  return parallel;
}

/** Metadata of a failed upload or create, never a body; a bug's error too, so the files that landed still print. */
function callErrorMeta(error: unknown): Record<string, unknown> {
  const bounded = (text: string) => (text.length <= 500 ? text : `${text.slice(0, 500)}... (truncated)`);
  if (!(error instanceof KernelApiError)) {
    return { status: null, code: "unexpected", message: bounded(error instanceof Error ? error.message : String(error)) };
  }
  const hint = publicationHint(error);
  return { status: error.status, code: error.code, message: bounded(error.message), ...(hint === null ? {} : { hint }) };
}

/** Files Hub would refuse, named before anything goes up. */
function refusedFiles(refused: ReadonlyArray<{ name: string; why: string }>, remedy: string): HubUsageError {
  const shown = refused.slice(0, 10).map((entry) => `${entry.name} (${entry.why})`).join("; ");
  const more = refused.length > 10 ? `; ${refused.length - 10} more in details` : "";
  return new HubUsageError(
    `${refused.length} ${refused.length === 1 ? "file" : "files"} Hub would refuse, so nothing was uploaded${remedy}: ${shown}${more}`,
    { refused },
  );
}

/** Hub's answer to which of a page's files it holds (`agentPublicationFileLookup`), as upload.ts asks it. */
function hubLookup(client: KernelClient, pageLabel: string): HubFileLookup {
  return async (files, keep) => (await client.agentPublicationFileLookup({ params: { pageLabel }, body: { files: [...files], keep } }))
    .files.map((entry) => entry.file);
}

/** Every file's SHA-256 from disk; a file that cannot be read whole stops the call before anything goes up. */
async function hashedFiles(deps: HubRunDeps, items: readonly HubUploadItem[]): Promise<HubHashedItem[]> {
  try {
    return await hashHubFiles({ files: deps.files, items, now: deps.now, progress: deps.progress });
  } catch (error) {
    throw new HubUsageError(`a file could not be read whole, so nothing was uploaded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type HubUploadDone = Extract<HubUploadOutcome, { ok: true }>;

function uploadsOf(outcomes: readonly HubUploadOutcome[]) {
  const done = outcomes.filter((outcome): outcome is HubUploadDone => outcome.ok);
  const bytes = outcomes.reduce((sum, outcome) => sum + outcome.item.byteSize, 0);
  return {
    files: outcomes.length,
    uploaded: done.filter((outcome) => outcome.created).length,
    alreadyThere: done.filter((outcome) => !outcome.created).length,
    /** Of alreadyThere: Hub said it held them when asked, so their bytes did not go up again. */
    notSent: done.filter((outcome) => outcome.notSent).length,
    failed: outcomes.length - done.length,
    bytes,
    size: formatHubBytes(bytes),
  };
}

/** One file's upload as the document prints it; `full` adds what a draft does not need (sha256, the try count);
 *  `hubName` the name Hub kept the same bytes under, when it is another (a vault album's draft names its cards itself). */
function uploadResult(outcome: HubUploadOutcome, full: boolean, hubName = true): Record<string, unknown> {
  if (!outcome.ok) {
    return "notTried" in outcome
      ? { ok: false, notTried: outcome.notTried }
      : { ok: false, error: callErrorMeta(outcome.error), attempts: outcome.attempts };
  }
  const { file, created } = outcome;
  return {
    ok: true,
    media: `file:${file.id}`,
    alreadyThere: !created,
    ...(outcome.notSent ? { notSent: true } : {}),
    // The same bytes uploaded before under another name keep that name in Hub.
    ...(hubName && file.originalName !== null && file.originalName !== outcome.item.name ? { nameInHub: file.originalName } : {}),
    ...(full ? { id: file.id, sha256: file.sha256, byteSize: file.byteSize, mimeType: file.mimeType, attempts: outcome.attempts } : {}),
  };
}

/** A vault album draft's own key: the same page, title, files and names answer the first draft (another time is 409). */
export function hubVaultAlbumIdempotencyKey(pageLabel: string, title: string, fileIds: readonly number[], names: readonly string[]): string {
  return uuidOf(`vault_album\u0000${pageLabel}\u0000${title}\u0000${fileIds.join(",")}\u0000${names.join("\u0000")}`);
}

/** A failed create may be the network or a busy hub: the same key and body answer the same draft, so it is sent again. */
function createRetryable(error: unknown): boolean {
  return error instanceof KernelApiError && (error.category === "network" || error.status === 429 || (error.status ?? 0) >= 500);
}

/**
 * What a create that failed for good means for the draft, said as it is.
 * Hub refused it (an error answer): nothing drafted. Hub answered 200 but this
 * copy of the CLI could not read the answer (it is not the release Hub runs,
 * most likely because its update check did not get through), or no answer
 * came back, or Hub broke after it: the draft may well exist, and the message
 * never says it does not.
 */
function createFailure(error: unknown, pageLabel: string): { drafted: false | "unknown"; next: string } {
  const list = `hub publication-list --page-label ${pageLabel} --status draft`;
  if (error instanceof KernelApiError && error.code === "idempotency_mismatch") {
    return {
      drafted: false,
      next: `This command drafted this page, title and files before, at another time: find that publication with hub`
        + ` publication-list --page-label ${pageLabel} and follow it there (a draft: edit or cancel it). To send the`
        + " album again (its files that did not land, its order), draft its files anew as the hub skill says — no"
        + " bytes go up again; a second draft of this folder needs --idempotency-key with a new uuid.",
    };
  }
  if (error instanceof KernelApiError && error.category === "contract") {
    return {
      drafted: "unknown",
      next: "Hub answered the draft with 200, so it is most likely drafted, but this copy of the CLI could not read the"
        + " answer: it is not the release Hub runs (most likely its update check did not get through). Do not draft again: run"
        + ` ${list} — the CLI updates itself first when it reaches Hub — and follow this album's draft there.`,
    };
  }
  if (error instanceof KernelApiError && (error.category === "network" || (error.status ?? 0) >= 500)) {
    return {
      drafted: "unknown",
      next: "Whether Hub drafted it is unknown: no answer came back. Every file is in Hub (album[].media). Run"
        + ` ${list}: a draft of this title made just now is this one; if there is none, run the same command again —`
        + " no bytes go up again.",
    };
  }
  return {
    drafted: false,
    next: "Nothing drafted: Hub refused it (error). Every file is in Hub (album[].media); fix what the error says and"
      + " run the same command again — no bytes go up again.",
  };
}

function albumTitle(values: HubOptionValues): string {
  const title = requireString(values, "title").trim();
  if (title === "" || /[\r\n]/.test(title)) throw new HubUsageError("--title is the album's title: one line, not empty");
  if (title.length > PUBLICATION_VAULT_ALBUM_TITLE_MAX) {
    throw new HubUsageError(`--title has at most ${PUBLICATION_VAULT_ALBUM_TITLE_MAX} characters, got ${title.length}`);
  }
  return title;
}

// --- an OnlyFans vault album's price before «да» (vault-album-draft, 8-docs 2026-11-12-of-vault-album) ---

type VaultAlbumQuote = KernelOperationResponse<"agentVaultAlbumQuote">;

/** How long the draft waits for a walk of the page's albums Hub asked for, and how often it asks again meanwhile. */
export const VAULT_WALK_WAIT_MS = 3 * 60_000;
export const VAULT_WALK_POLL_MS = 20_000;

function readAlbumRef(values: HubOptionValues): string | null {
  const ref = readString(values, "album-ref")?.trim();
  if (ref === undefined) return null;
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(ref)) throw new HubUsageError(`--album-ref is an album id as the dry run printed it, got "${ref}"`);
  return ref;
}

function readMaxCredits(values: HubOptionValues): number | null {
  const credits = readNumber(values, "max-credits");
  if (credits === undefined) return null;
  if (!Number.isSafeInteger(credits) || credits < 0) throw new HubUsageError(`--max-credits is a whole number of credits, got "${String(credits)}"`);
  return credits;
}

/** A stand-in hash for a file whose bytes are not read (yet, or ever: over the link limit); it matches nothing in Hub. */
function unreadSha256(index: number, item: HubUploadItem): string {
  return createHash("sha256").update(`unread\u0000${index}\u0000${item.name}\u0000${item.byteSize}`).digest("hex");
}

/** The quote of these files, in the folder's order; every call counted. */
function vaultQuoter(client: KernelClient, pageLabel: string, title: string, albumRef: string | null, count: () => void) {
  return (files: readonly HubHashedItem[]): Promise<VaultAlbumQuote> => {
    count();
    return client.agentVaultAlbumQuote({
      params: { pageLabel },
      body: {
        title,
        ...(albumRef === null ? {} : { albumRef }),
        files: files.map((file) => ({ sha256: file.sha256, byteSize: file.byteSize, name: file.name.slice(0, 255) })),
      },
    });
  };
}

/** A file's marks in the album list: its credits, already on the page, over the link limit. */
function vaultQuoteFileMarks(file: VaultAlbumQuote["files"][number] | undefined): Record<string, unknown> {
  if (file === undefined) return {};
  return { credits: file.credits, ...(file.onPage ? { onPage: true } : {}), ...(file.tooBig ? { tooBig: true } : {}) };
}

type VaultQuoteSummary = ReturnType<typeof vaultQuoteSummary>;

/** What a person must hear before «да», from the quote alone: no number here is the CLI's own. */
function vaultQuoteSummary(quote: VaultAlbumQuote, items: readonly HubUploadItem[]) {
  const named = (position: number) => ({ position: position + 1, name: items[position]?.name ?? `#${position + 1}` });
  const account = quote.account;
  return {
    price: { credits: quote.credits, usd: quote.usd },
    /** The albums' day: ceiling, spent, left; the last balance Hub read (null: never read). */
    account: account === null ? null : {
      dailyCredits: account.dailyCredits, spentToday: account.spentToday, left: account.left, balance: account.balance,
      fitsToday: quote.credits <= account.left,
    },
    albumFound: {
      kind: quote.album.kind,
      albumRef: quote.album.albumRef,
      mediaCount: quote.album.mediaCount,
      similar: quote.album.similar,
      knownAt: quote.album.knownAt,
      /** Hub is still reading the page's albums: a look-alike or the album itself may yet turn up. */
      walkPending: quote.album.walkRequested && quote.album.kind !== "found",
    },
    /** Over the link limit: not uploaded, not drafted, added by hand after the album — they land on top. */
    byHand: quote.files.filter((file) => file.tooBig).map((file) => ({ ...named(file.position), size: formatHubBytes(file.byteSize) })),
    linkMax: quote.linkMaxBytes === null ? null : formatHubBytes(quote.linkMaxBytes),
    /** Hub uploaded these bytes to the page before: not paid, they keep their old place by date. */
    onPage: quote.files.filter((file) => file.onPage).map((file) => named(file.position)),
    /** The album's order top first when it will not be the folder's; null: the folder's. */
    expectedOrder: quote.expectedOrder === null ? null : quote.expectedOrder.map((position, place) => ({ place: place + 1, ...named(position) })),
    sending: quote.sending,
  };
}

/** The dry run's last word for an OnlyFans page: what goes into the one question. */
function vaultQuoteNext(priced: VaultQuoteSummary, inHub: number): string {
  const { albumFound: album } = priced;
  const parts = ["Nothing uploaded or drafted. Into the one question to the owner (several pages: one question, each page's price and the sum):"
    + " the order (position 1 on top), the count and size" + (inHub > 0 ? ` (${inHub} files are in Hub already)` : "")
    + `; the price ${priced.price.credits} credits ≈ $${priced.price.usd}`
    + (priced.account === null ? "" : `; left today ${priced.account.left} of ${priced.account.dailyCredits}, balance ${priced.account.balance ?? "unknown"}`)];
  if (album.kind === "found") parts.push(`the album is the page's ${album.albumRef} (${album.mediaCount ?? "?"} files)`);
  if (album.kind === "new") parts.push("the album is new");
  if (album.kind === "similar") {
    parts.push("no album has exactly this title, these are alike (albumFound.similar): ask «в него?» — yes: --album-ref <its albumRef>; a new one on purpose: --new-album");
  }
  if (album.walkPending) parts.push("Hub is still reading the page's albums: run --dry-run again in a few minutes before asking");
  if (priced.byHand.length > 0) parts.push(`${priced.byHand.length} files over ${priced.linkMax} do not go (byHand): added by hand after the album, they land on top`);
  if (priced.onPage.length > 0) parts.push(`${priced.onPage.length} files Hub uploaded to the page before (onPage): not paid, they keep their old place`);
  if (priced.expectedOrder !== null) parts.push("the order will NOT be the folder's: say so and show expectedOrder");
  if (!priced.sending.on) parts.push(`sending is held now (${priced.sending.why}): the ceiling and the balance are the owner's`);
  if (priced.account !== null && !priced.account.fitsToday) parts.push("the price is over what is left today: the album waits for the day's room, or the owner raises the ceiling");
  parts.push(`On «да»: the same command without --dry-run, with --max-credits ${priced.price.credits}`);
  return `${parts.join("; ")}.`;
}

/** Why the real run stops before any byte goes to Hub; null: it goes on. */
export function vaultQuoteStop(
  priced: Pick<VaultQuoteSummary, "albumFound" | "price">,
  given: { albumRef: string | null; newAlbum: boolean; maxCredits: number; filesToSend: number },
): { code: string; next: string } | null {
  const chosen = given.albumRef !== null || given.newAlbum;
  if (priced.albumFound.kind === "similar" && !chosen) {
    return {
      code: "album_title_similar",
      next: "Nothing uploaded or drafted: the page has no album with exactly this title, but these are alike (albumFound.similar)."
        + " Ask the person «в него?»: yes — run again with --album-ref <its albumRef>; a new album on purpose — with --new-album.",
    };
  }
  if (priced.albumFound.walkPending && !chosen) {
    return {
      code: "album_list_not_read",
      next: "Nothing uploaded or drafted: Hub is still reading the page's albums, so an album like this one may be there."
        + " Run the same command again in a few minutes; or, on the person's word, name the album (--album-ref) or say it is new (--new-album).",
    };
  }
  if (priced.price.credits > given.maxCredits) {
    return {
      code: "price_over_max_credits",
      next: `Nothing uploaded or drafted: the album now costs ${priced.price.credits} credits, over --max-credits ${given.maxCredits}`
        + " the person agreed to. Name the new price and ask again.",
    };
  }
  if (given.filesToSend === 0) {
    return {
      code: "every_file_by_hand",
      next: "Nothing uploaded or drafted: every file is over the link limit (byHand), so they are all added by hand.",
    };
  }
  return null;
}

/**
 * An OnlyFans album's run in one line, for `publication-get`'s note: the step,
 * done of all, the file going up now, credits spent of the price, and the files
 * that did not land by group. Null: not an OnlyFans album.
 */
export function albumRunLine(run: KernelOperationResponse<"agentPublicationGet">["albumRun"] | null): string | null {
  if (run === null || run === undefined) return null;
  const step = run.step === null ? "not started" : run.step === "done" ? "done" : `step ${run.step}`;
  const landed = run.done + run.reused;
  const parts = [`Album ${step}: ${landed} of ${run.files} files in (${run.done} uploaded, ${run.reused} taken without paying)`];
  if (run.currentFile !== null) parts.push(`now ${run.currentFile}`);
  parts.push(`credits ${run.spentCredits} spent of ${run.estimateCredits}`);
  const group = (state: string) => run.fileList.filter((file) => file.state === state).map((file) => file.name);
  const groups: Array<[string, string[]]> = [
    ["refused (a re-send pays only for them)", group("failed")],
    ["outcome unknown (never re-sent without a person looking at the vault)", group("unknown")],
    ["too big (added by hand, they land on top)", group("too_big")],
    ["not tried", [...group("not_tried"), ...(run.step === "done" ? group("pending") : [])]],
  ];
  for (const [label, names] of groups) {
    if (names.length > 0) parts.push(`${label}: ${names.length} — ${names.slice(0, 20).join(", ")}${names.length > 20 ? ", …" : ""}`);
  }
  if (run.stopReason !== null) parts.push(`uploads stopped: ${run.stopReason}`);
  if (run.account !== null) parts.push(`the albums' day: ${run.account.left} of ${run.account.dailyCredits} left, balance ${run.account.balance ?? "unknown"}`);
  return `${parts.join("; ")}.`;
}

/**
 * `vault-album-draft`: the folder read and checked, the page checked, every
 * file's SHA-256 read (twins stop it there, before any upload), Hub asked
 * which of the files it holds, the others uploaded, then one vault_album
 * draft with them in the folder's order. Nothing is drafted unless every file
 * is in Hub, each once; the same command again sends only what Hub lacks.
 */
async function draftVaultAlbum(client: KernelClient, values: HubOptionValues, deps: HubRunDeps, folderArgument: string) {
  const pageLabel = requireString(values, "page-label");
  const title = albumTitle(values);
  const publishAt = readString(values, "publish-at");
  const dryRun = readFlag(values, "dry-run");
  const parallel = readParallel(values);
  const givenKey = readIdempotencyKey(values);
  const albumRef = readAlbumRef(values);
  const newAlbum = readFlag(values, "new-album");
  if (albumRef !== null && newAlbum) throw new HubUsageError("--album-ref names the page's album; --new-album says there is none: one of them");
  const maxCredits = readMaxCredits(values);
  // The draft's shape now, so a bad --publish-at stops the call before the uploads, not after them.
  checkedDraft(agentPublicationCreateBodySchema, {
    kind: "vault_album", text: title, media: [{ source: "file", fileId: 1 }],
    publishAt: publishAt ?? new Date(deps.now()).toISOString(), idempotencyKey: givenKey ?? "check",
  });

  const folder = resolve(folderArgument);
  let listing: HubAlbumFolder;
  try {
    listing = await readHubAlbumFolder(deps.files, folder);
  } catch {
    throw new HubUsageError(`${folder} is not a folder that can be read`);
  }
  if (listing.refused.length > 0) {
    throw refusedFiles(listing.refused, " (convert them, or move them out of the folder)");
  }
  const items = listing.items;
  if (items.length === 0) throw new HubUsageError(`no photo or video Hub takes in ${folder}`, { skipped: listing.skipped });
  if (items.length > PUBLICATION_VAULT_ALBUM_MEDIA_MAX) {
    throw new HubUsageError(`a vault album holds at most ${PUBLICATION_VAULT_ALBUM_MEDIA_MAX} files; ${folder} has ${items.length}`);
  }
  // The key's right and the page, before the first byte.
  const targets = await client.agentPublicationTargets({ params: { pageLabel } });
  const onlyfans = targets.platform === "onlyfans";
  if (targets.platform !== "fansly" && !onlyfans) throw new HubUsageError(`vault albums are Fansly's and OnlyFans'; ${pageLabel} is a ${targets.platform} page`);
  if (!onlyfans && newAlbum) {
    // Unread there, it would promise a new album and fill the page's same-titled one (review, 2026-11-12).
    throw new HubUsageError("--new-album is OnlyFans' (a similar title found there): on Fansly the files go into the page's album with"
      + " exactly this title, and into a new one when it has none — for a new album give another --title");
  }
  if (onlyfans && !dryRun && maxCredits === null) {
    throw new HubUsageError("an OnlyFans album costs OnlyFansAPI credits: run --dry-run first, name its price to the owner, and on"
      + " their «да» run this with --max-credits <that price> (the run stops before any byte when the price is higher)");
  }

  const bytes = items.reduce((sum, item) => sum + item.byteSize, 0);
  const photos = items.filter((item) => item.mimeType.startsWith("image/")).length;
  const plan = {
    pageLabel,
    title,
    folder,
    /** null: when the draft is made. */
    publishAt: publishAt ?? null,
    totals: { files: items.length, photos, videos: items.length - photos, bytes, size: formatHubBytes(bytes) },
    album: items.map((item, index) => ({
      position: index + 1, name: item.name, size: formatHubBytes(item.byteSize), byteSize: item.byteSize, mimeType: item.mimeType,
    })),
    skipped: listing.skipped,
  };

  let calls = 1;
  // OnlyFans: the price asked before the files are read, so an old list of the page's albums is walked meanwhile.
  const quoter = onlyfans ? vaultQuoter(client, pageLabel, title, albumRef, () => { calls += 1; }) : null;
  const early = quoter === null ? null : await quoter(items.map((item, index) => ({ ...item, sha256: unreadSha256(index, item) })));
  // A file over the link limit never goes (added by hand): its bytes are not read either.
  const sendable = (item: HubUploadItem) => early?.linkMaxBytes == null || item.byteSize <= early.linkMaxBytes;

  // Twins and the files Hub holds, from the bytes, before any upload.
  const hashedSendable = await hashedFiles(deps, items.filter(sendable));
  const hashed: HubHashedItem[] = [];
  for (const [index, item] of items.entries()) {
    hashed.push(sendable(item) ? hashedSendable.shift()! : { ...item, sha256: unreadSha256(index, item) });
  }
  const duplicates = hubFileTwins(hashed);
  if (duplicates.length > 0) {
    return new HubCompositeResult({
      ...(dryRun ? { dryRun: true } : {}), ...plan, duplicates, drafted: false,
      next: "Nothing uploaded or drafted: the folder holds the same file twice (duplicates: a file and the one it"
        + " repeats) and an album holds a file once. Ask the owner which copy stays, move the other out of the folder"
        + ` and run ${dryRun ? "--dry-run " : ""}again.`,
    }, duplicates.length, { calls, failed: duplicates.length });
  }

  let quote: VaultAlbumQuote | null = null;
  if (quoter !== null) {
    quote = await quoter(hashed);
    // The page's albums are being walked: the album may yet be found, or a look-alike turn up. Waited for a bounded time.
    const deadline = deps.now() + VAULT_WALK_WAIT_MS;
    while (quote.album.walkRequested && quote.album.kind !== "found" && deps.now() < deadline) {
      deps.progress("hub: Hub is reading the page's albums anew, the album is looked for again in a moment");
      await deps.sleep(VAULT_WALK_POLL_MS);
      quote = await quoter(hashed);
    }
  }
  const priced = quote === null ? null : vaultQuoteSummary(quote, hashed);
  const tooBig = new Set(quote?.files.filter((file) => file.tooBig).map((file) => file.position) ?? []);

  if (dryRun) {
    // Asked without keeping anything: a dry run changes nothing in Hub.
    const lookup = hubLookup(client, pageLabel);
    let found: Map<string, HubFileRef> | null = null;
    try {
      found = await hubFilesHeld((files, keep) => {
        calls += 1;
        return lookup(files, keep);
      }, hashed.filter((_item, index) => !tooBig.has(index)), false);
    } catch {
      // An older Hub, or no answer: the real run asks again, and uploads every file when it cannot.
    }
    const held = found;
    const inHub = held === null ? [] : hashed.filter((item, index) => !tooBig.has(index) && held.has(item.sha256));
    const inHubBytes = inHub.reduce((sum, item) => sum + item.byteSize, 0);
    const album = plan.album.map((entry, index) => ({
      ...entry,
      ...(!tooBig.has(index) && held?.has(hashed[index]!.sha256) ? { inHub: true } : {}),
      ...(quote === null ? {} : vaultQuoteFileMarks(quote.files[index])),
    }));
    return new HubCompositeResult({
      dryRun: true,
      ...plan,
      album,
      /** null: Hub could not be asked which files it holds. */
      inHub: held === null ? null : { files: inHub.length, bytes: inHubBytes, size: formatHubBytes(inHubBytes) },
      ...(priced ?? {}),
      next: priced === null
        ? "Nothing uploaded or drafted. Show the owner the order (position 1 is the top of the album), the count and the"
          + " size" + (inHub.length > 0 ? ` (${inHub.length} of the files are in Hub already, inHub: they do not go up again)` : "")
          + "; on their word run the same command without --dry-run. Which album is not said here: on Fansly the files go into"
          + " the page's album with exactly this title, and into a new one when it has none."
        : vaultQuoteNext(priced, inHub.length),
    }, 0, { calls, failed: 0 });
  }

  if (priced !== null) {
    const stop = vaultQuoteStop(priced, { albumRef, newAlbum, maxCredits: maxCredits!, filesToSend: hashed.length - tooBig.size });
    if (stop !== null) {
      return new HubCompositeResult({ ...plan, ...priced, drafted: false, stopped: stop.code, next: stop.next }, 1, { calls, failed: 1 });
    }
  }
  // Files over the link limit stay out of Hub and out of the draft: listed for the person (byHand).
  const toSend = hashed.filter((_item, index) => !tooBig.has(index));
  const sentPlan = plan.album.filter((_entry, index) => !tooBig.has(index));

  const { outcomes, attempts, lookups } = await sendHubFiles({
    pageLabel, items: toSend, parallel, upload: deps.upload, lookup: hubLookup(client, pageLabel),
    sleep: deps.sleep, now: deps.now, progress: deps.progress,
  });
  calls += lookups + attempts;
  const uploads = uploadsOf(outcomes);
  const album = sentPlan.map((entry, index) => ({ ...entry, ...uploadResult(outcomes[index]!, false, false) }));
  /** What the answers below carry of the price (OnlyFans): the person hears it all again with the draft. */
  const priceFacts = priced === null ? {} : { price: priced.price, account: priced.account, byHand: priced.byHand, sending: priced.sending };
  if (uploads.failed > 0) {
    // Too large, a type Hub refuses, Hub's room full: sending again changes nothing.
    const refusedByHub = outcomes.some((outcome) => !outcome.ok && "error" in outcome
      && outcome.error instanceof KernelApiError && [413, 415, 507].includes(outcome.error.status ?? 0));
    const inHub = uploads.files - uploads.failed;
    return new HubCompositeResult({
      ...plan, album, uploads, ...priceFacts, drafted: false,
      next: refusedByHub
        ? "Nothing drafted: Hub refused some files (album[].error says why). Tell the owner; once that is dealt with, run"
          + " the same command again: the files in Hub by then do not go up again."
        : `Nothing drafted: ${uploads.failed} of ${uploads.files} files did not reach Hub (album[].error), ${inHub} did.`
          + ` Run the same command again: the ${inHub} in Hub do not go up again (Hub keeps them 7 days), only the`
          + " missing ones, and the draft is made once all of them are in.",
    }, uploads.failed, { calls, failed: uploads.failed });
  }

  // No twins by now (their bytes were compared before any upload): each file id once, in the folder's order.
  const fileIds = outcomes.map((outcome) => (outcome as HubUploadDone).file.id);

  // Each card is named as the pack names its file (0349), whatever name Hub first kept the same bytes under.
  const names = toSend.map((item) => item.name.trim().slice(0, 200));
  const body = checkedDraft(agentPublicationCreateBodySchema, {
    kind: "vault_album",
    text: title,
    media: fileIds.map((fileId, index) => ({ source: "file", fileId, name: names[index]! })),
    ...(albumRef === null ? {} : { vaultAlbumRef: albumRef }),
    publishAt: publishAt ?? new Date(deps.now()).toISOString(),
    idempotencyKey: givenKey ?? hubVaultAlbumIdempotencyKey(pageLabel, title, fileIds, names),
  });
  let publication: KernelOperationResponse<"agentPublicationCreate">;
  for (let attempt = 1; ; attempt += 1) {
    calls += 1;
    try {
      publication = await client.agentPublicationCreate({ params: { pageLabel }, body });
      break;
    } catch (error) {
      const delay = CREATE_RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined || !createRetryable(error)) {
        return new HubCompositeResult({
          ...plan, album, uploads, ...priceFacts, ...createFailure(error, pageLabel), error: callErrorMeta(error),
        }, 1, { calls, failed: 1 });
      }
      deps.progress(`hub: drafting failed (${error instanceof KernelApiError ? error.status ?? error.code : "error"}), again in ${delay / 1000} s`);
      await deps.sleep(delay);
    }
  }

  // The same key and body answer the publication drafted before (the same command again): it may be long past a draft.
  if (publication.status !== "draft") {
    return new HubCompositeResult({
      publication: {
        id: publication.id,
        version: publication.version,
        status: publication.status,
        statusReason: publication.statusReason,
        pageLabel: publication.pageLabel,
        kind: publication.kind,
        title: publication.text,
        vaultAlbumRef: publication.vaultAlbumRef,
      },
      folder, totals: plan.totals, album, skipped: plan.skipped, uploads, ...priceFacts,
      next: `Nothing new drafted: this page, title and files are publication ${publication.id}, drafted before and now`
        + ` ${publication.status}${publication.statusReason === null ? "" : ` (${publication.statusReason})`}. Follow it with`
        + ` hub publication-get --id ${publication.id}. To send the album again (its files that did not land, its order),`
        + " draft its files anew as the hub skill says — no bytes go up again.",
    }, 0, { calls, failed: 0 });
  }

  const blocking = publication.findings.filter((finding) => finding.severity === "blocking").map((finding) => finding.code);
  return new HubCompositeResult({
    publication: {
      id: publication.id,
      version: publication.version,
      status: publication.status,
      pageLabel: publication.pageLabel,
      kind: publication.kind,
      title: publication.text,
      publishAt: publication.publishAt,
      vaultAlbumRef: publication.vaultAlbumRef,
      blocked: publication.blocked,
      findings: publication.findings,
    },
    folder, totals: plan.totals, album, skipped: plan.skipped, uploads, ...priceFacts,
    next: `Drafted publication ${publication.id}, version ${publication.version}.`
      + (priced === null ? "" : ` Its price: ${priced.price.credits} credits (≈ $${priced.price.usd}), within --max-credits ${maxCredits}.`
        + (priced.byHand.length > 0 ? ` ${priced.byHand.length} files are over the link limit and not in the draft: added by hand after the album, they land on top (byHand).` : "")
        + (priced.sending.on ? "" : ` Sending is held now (${priced.sending.why}): once approved, the album waits for it up to 12 hours.`))
      + (publication.vaultAlbumRef === null && priced !== null
        ? " Hub reads the page's albums afresh before it sends: the one with this title gets the files, none — Hub makes it."
        : publication.vaultAlbumRef === null
        ? " Hub makes a new album with this title once it is approved, unless by then the page has one with it (then"
          + " that one gets the files): say so to the owner — an album of this title made by hand within the last day"
          + " Hub may not know yet, and it would get a twin."
        : ` Its files go into the page's album ${publication.vaultAlbumRef}, the one with this title.`)
      + (blocking.length > 0 ? ` It cannot be approved as it is (${[...new Set(blocking)].join(", ")}).` : "")
      + " A person approves it: the owner in Hub, or hub publication-approve --id"
      + ` ${publication.id} --version ${publication.version} only on the owner's «да» in the chat for this album.`
      + ` Approve soon: Hub has until 12 hours after ${publication.publishAt} to send all of it, later it ends missed.`
      + ` Follow it with hub publication-get --id ${publication.id} or hub publication-changes.`,
  }, 0, { calls, failed: 0 });
}


// --- fan queues (docs/plans/2026-10-29-fan-queues) ---------------------------------

// --- matters (write:matters) ------------------------------------------------

const MATTER_CAPABILITY_HINT =
  "This key lacks write:matters: the owner grants it to the key (dashboard, Система, Агенты и ключи)";

/** What a refusal of the matters' door means, and what to do. */
function matterHint(error: { status: number | null; code: string | null }): string | null {
  if (error.status === 403 && error.code !== "forbidden") return MATTER_CAPABILITY_HINT;
  if (error.status === 409 && error.code === "matter_not_agents") {
    return "Hub's server keeps this kind (a mirror of «Ждут вас», a check, a shift report…) or another writer holds the key:"
      + " open your own kind (words with dots, e.g. reminder.team) under its own key";
  }
  if (error.status === 409 && error.code === "person_unknown") return "No living Hub login of that name: check --user / --watcher / --on-behalf-of";
  if (error.status === 404) return "No such matter, or a page outside this key's grant";
  return null;
}

/** `--evidence-file <path>` or `-` (stdin): one JSON object. */
function readEvidence(values: HubOptionValues, deps: HubRunDeps): Record<string, unknown> | undefined {
  const path = readString(values, "evidence-file");
  if (path === undefined) return undefined;
  const text = deps.readFile(path === "-" ? "/dev/stdin" : path);
  if (text === null) throw new HubUsageError(`--evidence-file ${path} cannot be read`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HubUsageError(`--evidence-file ${path} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HubUsageError(`--evidence-file ${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** `matter open`'s body: the key's kind is the key's own (`<kind>:<ref>`); whom it waits for is a login or a role. */
function matterOpenBody(values: HubOptionValues, deps: HubRunDeps, key: string) {
  const user = readString(values, "user");
  const role = readEnum(values, "role", MATTER_OWNER_ROLE_NAMES);
  if ((user === undefined) === (role === undefined)) throw new HubUsageError("say whom it waits for: --user <login> or --role owner | team_lead | chatter");
  const kind = matterKindOfKey(key);
  if (kind === "") throw new HubUsageError("the key is <kind>:<ref>, e.g. reminder.team:alice-2026-11-12");
  const object = readString(values, "object");
  if (object !== undefined && !/^[a-z][a-z0-9_]*:.+$/.test(object)) throw new HubUsageError("--object is <type>:<id>, e.g. fan:123456");
  return checkedDraft(agentMatterOpenBodySchema, defined({
    key,
    kind,
    title: requireString(values, "title"),
    owner: user !== undefined ? { user } : { role: role! },
    watchers: readList(values, "watcher"),
    object: object === undefined ? undefined : { type: object.slice(0, object.indexOf(":")), id: object.slice(object.indexOf(":") + 1) },
    pageLabels: readList(values, "page"),
    evidence: readEvidence(values, deps),
    money: readFlag(values, "money") ? true : undefined,
    link: readString(values, "link"),
    onBehalfOf: readString(values, "on-behalf-of"),
  }));
}

const MATTER_KEY_ARGUMENT = { name: "key", describe: "the reason key, <kind>:<ref> (the same finding, the same key)", min: 1, max: 1 };

const MATTER_COMMANDS: HubCommand[] = [
  {
    name: "matter open",
    operation: "agentMatterOpen",
    summary:
      "Say that something waits for a person: a matter by its reason key, for a login (--user) or a role (--role), shown in"
      + " «Ждут вас» (a chatter's also on the extension's icon). The same key again updates it (`transition`: updated or"
      + " unchanged), a closed one reopens. Only the agent's own kinds: one Hub's server keeps is refused (409"
      + " matter_not_agents). Exit 0 — Hub keeps it (read `transition`); 4 — refused or no answer. Needs write:matters.",
    example: 'hub matter open reminder.team:alice-2026-11-12 --title "Ответьте в «Обучалке» про смену 11 нояб." --user alice --page lora-2',
    arguments: MATTER_KEY_ARGUMENT,
    options: {
      title: { kind: "string", describe: "What waits, as the person reads it (required), up to 300 characters" },
      user: { kind: "string", describe: "Whom it waits for: a Hub login (or --role)" },
      role: { kind: "string", describe: `Whom it waits for: a role (or --user): ${MATTER_OWNER_ROLE_NAMES.join(" | ")}` },
      page: { kind: "list", describe: "A page it is about, of this key's grant (repeatable); none — every page's" },
      "evidence-file": { kind: "string", describe: "What the finding saw: a JSON object from a file, or - for stdin (up to 4 KB; no fan names, no message texts)" },
      money: { kind: "boolean", describe: "The evidence carries money: only the owner reads the matter" },
      link: { kind: "string", describe: "Where it is done: a path of the console or Workboard (/workboard/…)" },
      object: { kind: "string", describe: "What it is about, <type>:<id> (e.g. fan:123456)" },
      watcher: { kind: "list", describe: "A Hub login who sees it too (repeatable)" },
      "on-behalf-of": { kind: "string", describe: "The Hub login on whose word the agent writes" },
    },
    hint: matterHint,
    run: (client, values, deps, args) => client.agentMatterOpen({ body: matterOpenBody(values, deps, args[0]!) }),
  },
  {
    name: "matter close",
    operation: "agentMatterClose",
    summary:
      "Close the agent's own matter by its key: --how resolved (done, the default) | withdrawn (the agent was wrong) |"
      + " cause_gone (the cause went away by itself). A closed one stays as it was (`transition`: unchanged). Exit 0 —"
      + " closed or already closed; 4 — no such matter, another writer's, or no answer. Needs write:matters.",
    example: 'hub matter close reminder.team:alice-2026-11-12 --how resolved --note "ответила в 18:40"',
    arguments: MATTER_KEY_ARGUMENT,
    options: {
      how: { kind: "string", describe: `How it ended: ${MATTER_CLOSED_HOWS.join(" | ")} (default resolved)` },
      note: { kind: "string", describe: "A line for the matter's history, up to 500 characters" },
      "on-behalf-of": { kind: "string", describe: "The Hub login on whose word the agent writes" },
    },
    hint: matterHint,
    run: (client, values, _deps, args) => client.agentMatterClose({
      body: checkedDraft(agentMatterCloseBodySchema, defined({
        key: args[0]!,
        how: readEnum(values, "how", MATTER_CLOSED_HOWS) ?? "resolved",
        note: readString(values, "note"),
        onBehalfOf: readString(values, "on-behalf-of"),
      })),
    }),
  },
  {
    name: "matter comment",
    operation: "agentMatterComment",
    summary:
      "Add a line to a matter's history by its key (any writer's matter of this key's pages); the text stays in Hub, the"
      + " audit keeps only its digest. Exit 0 — written; 4 — no such matter or no answer. Needs write:matters.",
    example: 'hub matter comment reminder.team:alice-2026-11-12 --text "Сказала: ответит вечером" --on-behalf-of alice',
    arguments: MATTER_KEY_ARGUMENT,
    options: {
      text: { kind: "string", describe: "The line (required), up to 2000 characters" },
      "on-behalf-of": { kind: "string", describe: "The Hub login on whose word the agent writes" },
    },
    hint: matterHint,
    run: (client, values, _deps, args) => client.agentMatterComment({
      body: checkedDraft(agentMatterCommentBodySchema, defined({
        key: args[0]!, text: requireString(values, "text"), onBehalfOf: readString(values, "on-behalf-of"),
      })),
    }),
  },
];

// --- custom orders (write:customs) -----------------------------------------

const CUSTOM_CAPABILITY_HINT =
  "This key lacks write:customs: the owner grants it to the key (dashboard, Система, Агенты и ключи)";

/** The machine reason of a refusal (`version_changed`, `edited_by_person`…), from the hub's error body. */
function refusalReason(error: unknown): string | null {
  const reason = (error as { body?: { reason?: unknown } } | null)?.body?.reason;
  return typeof reason === "string" ? reason : null;
}

/** What a refusal of the custom orders' door means, and what to do. */
function customHint(error: { status: number | null; code: string | null }): string | null {
  const reason = refusalReason(error);
  if (error.status === 403 && error.code !== "forbidden") return CUSTOM_CAPABILITY_HINT;
  if (error.status === 409 && reason === "version_changed") {
    return "version_changed: the order changed since the version you read. Read it again (hub custom list --code K-…) and send only"
      + " what still differs from the card";
  }
  if (error.status === 409 && reason === "edited_by_person") {
    return "edited_by_person: a person edited these fields on the board (the message names them). They are the person's now:"
      + " leave them and say the difference in your summary";
  }
  if (error.status === 409 && reason === "not_allowed") {
    return "not_allowed: the order's state takes no such step (read its `state`): a delivery to an order already given, a refusal"
      + " of an order not at the model…";
  }
  if (error.status === 409 && reason === "taken") return "taken: this Telegram card belongs to another order (hub custom list --card <ref>)";
  if (error.status === 409 && reason === "person_unknown") return "No living Hub login of that name: check --accepted-by / --on-behalf-of";
  if (error.status === 404) return "No such order, or its page is outside this key's grant (an order of no known page is every key's)";
  return null;
}

const CUSTOM_STEPS = [
  "at_model", "delivery", "partly", "shot", "revision", "revision_done", "refused", "cancel", "message", "edit", "card",
] as const;
type CustomStepName = (typeof CUSTOM_STEPS)[number];
const CUSTOM_MESSAGE_KINDS = ["repost", "confirmation", "note"] as const;
/** `--state`: the door's own two (open, all), or one state of an order (read from all, filtered here). */
const CUSTOM_LIST_STATES = ["open", "all", ...CUSTOM_ORDER_STATES] as const;

/** A JSON object from `--<name>` (a file, or - for stdin). */
function readJsonObject(values: HubOptionValues, deps: HubRunDeps, name: string): Record<string, unknown> | undefined {
  const path = readString(values, name);
  if (path === undefined) return undefined;
  const text = deps.readFile(path === "-" ? "/dev/stdin" : path);
  if (text === null) throw new HubUsageError(`--${name} ${path} cannot be read`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HubUsageError(`--${name} ${path} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HubUsageError(`--${name} ${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** The model's message: its link (`--message`), when, who and a short verbatim excerpt. */
function customMessage(values: HubOptionValues) {
  return defined({
    telegramRef: requireString(values, "message"),
    at: readString(values, "at"),
    author: readString(values, "author"),
    excerpt: readString(values, "excerpt"),
  });
}

/** `custom step`'s body: one step of the order, its message and words from the flags. */
export function customStepBody(values: HubOptionValues, deps: HubRunDeps) {
  const step: CustomStepName = requireEnum(values, "step", CUSTOM_STEPS);
  const onBehalfOf = readString(values, "on-behalf-of");
  const ordinal = readNumber(values, "ordinal");
  let body: Record<string, unknown>;
  switch (step) {
    case "at_model":
      body = { telegramRef: readString(values, "card") };
      break;
    case "card":
      body = { telegramRef: requireString(values, "card") };
      break;
    case "delivery":
      body = { message: customMessage(values), part: readEnum(values, "part", ["video", "photos"] as const), complete: readFlag(values, "complete") };
      break;
    case "partly":
      body = { ref: requireString(values, "message"), note: readString(values, "text") };
      break;
    case "shot":
      body = { ref: requireString(values, "message") };
      break;
    case "revision":
      body = { message: customMessage(values), ordinal, text: requireString(values, "text") };
      break;
    case "revision_done":
      body = { telegramRef: requireString(values, "message"), ordinal };
      break;
    case "refused":
      body = { ref: requireString(values, "message"), reason: requireString(values, "reason") };
      break;
    case "cancel":
      body = { reason: requireString(values, "reason") };
      break;
    case "message":
      body = { kind: requireEnum(values, "kind", CUSTOM_MESSAGE_KINDS), message: customMessage(values) };
      break;
    case "edit": {
      const card = readJsonObject(values, deps, "card-file");
      const deadline = readString(values, "deadline");
      const sourceFile = readString(values, "source-file");
      if (card === undefined && deadline === undefined && sourceFile === undefined) {
        throw new HubUsageError("an edit says what changed: --card-file (only the changed fields; null empties one), --deadline or --source-file");
      }
      body = {
        card: card ?? {},
        deadlineOn: deadline === undefined ? undefined : deadline === "none" ? null : deadline,
        sourceText: sourceFile === undefined ? undefined : readTextFile(deps, sourceFile),
        ifVersion: readNumber(values, "if-version"),
      };
      break;
    }
  }
  return checkedDraft(agentCustomOrderUpdateBodySchema, defined({ action: step, ...defined(body), onBehalfOf }));
}

/** `custom create`'s body: the card's JSON from --file, the flags laid over it. */
export function customCreateBody(values: HubOptionValues, deps: HubRunDeps) {
  const fromFile = readJsonObject(values, deps, "file") ?? {};
  return checkedDraft(agentCustomOrderCreateBodySchema, {
    ...fromFile,
    ...defined({
      pageLabel: readString(values, "page"),
      fan: readString(values, "fan"),
      acceptedBy: readString(values, "accepted-by"),
      telegramRef: readString(values, "card"),
      deadlineOn: readString(values, "deadline"),
      onBehalfOf: readString(values, "on-behalf-of"),
    }),
  });
}

const CUSTOM_CODE_ARGUMENT = { name: "code", describe: "the order's code, K-<number>", min: 1, max: 1 };

const CUSTOM_COMMANDS: HubCommand[] = [
  {
    name: "custom list",
    operation: "agentCustomOrders",
    summary:
      "Custom orders of this key's pages and of no known page, the newest first: the state as the server keeps it, overdueDays"
      + " (past the deadline and not delivered whole), the deadline, the parts delivered whole, the open revision requests,"
      + " the messages already recorded, the version and the card text with its code. --card or --code finds one order in"
      + " any state. No money. Exit 0 — answered; 4 — refused or no answer. Needs write:customs.",
    example: "hub custom list --card https://t.me/c/2600000001/3/10017",
    options: {
      state: { kind: "string", describe: `open (default: not given and not ended) | all | one state: ${CUSTOM_ORDER_STATES.join(" | ")}` },
      page: { kind: "string", describe: "Only this page's orders (an order of no known page shows on every page)" },
      card: { kind: "string", describe: "The order of this Telegram card: https://t.me/c/<chat>/<topic>/<msg> or tg:<chat>/<topic>/<msg>" },
      code: { kind: "string", describe: "The order of this code, K-<number>" },
      limit: { kind: "number", describe: "At most this many orders" },
    },
    hint: customHint,
    run: async (client, values) => {
      const state = readEnum(values, "state", CUSTOM_LIST_STATES);
      const page = readString(values, "page");
      const answer = await client.agentCustomOrders({
        query: defined({
          state: state === undefined || state === "open" ? "open" as const : "all" as const,
          code: readString(values, "code"),
          telegramRef: readString(values, "card"),
          limit: readNumber(values, "limit"),
        }),
      });
      const orders = answer.orders.filter((order) => (page === undefined || order.pageLabel === page || order.pageLabel === null)
        && (state === undefined || state === "open" || state === "all" || order.state === state));
      return { ...answer, orders };
    },
  },
  {
    name: "custom create",
    operation: "agentCustomOrderCreate",
    summary:
      "Record a custom order from the card's fields (--file, a JSON object: card, pageLabel, fan, acceptedBy, deadlineOn, telegramRef,"
      + " postedAt, author, sourceText) and the fan's link; flags override the file. A fan that matches no fan of the page stays the"
      + " buyer's string; no page — the order waits for a person to confirm it. The same Telegram card again answers its order"
      + " (`outcome`: unchanged). Prints the order's code: put «K-…» into the card's title. Exit 0 — recorded or already there;"
      + " 4 — refused or no answer. Needs write:customs.",
    example: "hub custom create --file card.json --page lora-1 --fan https://fansly.com/fan_name/posts --accepted-by alice",
    options: {
      file: { kind: "string", describe: "The order as a JSON object (required): {card: {task, price, duration, …}, …}; - for stdin" },
      page: { kind: "string", describe: "The fan's page, of this key's grant" },
      fan: { kind: "string", describe: "The fan: a profile link, a username or the platform's number" },
      "accepted-by": { kind: "string", describe: "The Hub login of the chatter who took the order" },
      card: { kind: "string", describe: "The card's message in Telegram, when it is posted already" },
      deadline: { kind: "string", describe: "The deadline, YYYY-MM-DD (Moscow)" },
      "on-behalf-of": { kind: "string", describe: "The Hub login on whose word the agent writes" },
    },
    hint: customHint,
    run: async (client, values, deps) => {
      if (readString(values, "file") === undefined) throw new HubUsageError("--file is required: the order as a JSON object");
      const answer = await client.agentCustomOrderCreate({ body: customCreateBody(values, deps) });
      const code = answer.order.code;
      return new HubNotedResult(answer, answer.outcome === "created"
        ? `Recorded ${code}: put «${code}» into the card's title (its cardText has it).`
        : `This card has its order already: ${code} (version ${answer.order.version}).`);
    },
  },
  {
    name: "custom step",
    operation: "agentCustomOrderUpdate",
    summary:
      "One step of an order, from what the models' group says (--step): at_model (the card reached the model's group; --card its copy"
      + " there), delivery (the model delivered: --message, --excerpt her line verbatim, --part video|photos, --complete when that part"
      + " is whole), partly | shot (--message), revision (a request: --message, --text, --ordinal for several in one message),"
      + " revision_done (--message, --ordinal), refused (the model's refusal: --message, --reason), cancel (--reason: a return, a"
      + " duplicate card), message (--kind repost | confirmation | note, --message), edit (only the changed fields: --card-file,"
      + " --deadline, --source-file, --if-version), card (attach --card). The same message again changes nothing (`outcome`:"
      + " unchanged). Exit 0 — changed or unchanged; 4 — refused (409 version_changed, edited_by_person, not_allowed: read"
      + " `error.reason`) or no answer. Never a payment or «отдали»: those are people's. Needs write:customs.",
    example: 'hub custom step K-123 --step delivery --message https://t.me/c/2600000001/3/10030 --excerpt "6-08 название.mov" --part video --complete',
    arguments: CUSTOM_CODE_ARGUMENT,
    options: {
      step: { kind: "string", describe: `The step (required): ${CUSTOM_STEPS.join(" | ")}` },
      message: { kind: "string", describe: "The model's (or the team's) message: https://t.me/c/<chat>/<topic>/<msg> or tg:…" },
      at: { kind: "string", describe: "When the message was sent, ISO 8601" },
      author: { kind: "string", describe: "Who sent it, as Telegram names them" },
      excerpt: { kind: "string", describe: "A short verbatim excerpt (a delivery: the model's line with the file's name)" },
      part: { kind: "string", describe: "A delivery's part: video | photos (default: the first the card orders)" },
      complete: { kind: "boolean", describe: "A delivery: that part is whole now (without it the part waits for more)" },
      ordinal: { kind: "number", describe: "Several revision requests in one message: 1, 2… (default 0)" },
      text: { kind: "string", describe: "A revision's request, or what a partial delivery is about" },
      reason: { kind: "string", describe: "Why the model refused, or why the order is cancelled" },
      kind: { kind: "string", describe: `A message's kind: ${CUSTOM_MESSAGE_KINDS.join(" | ")} (a repost also becomes a card of the order)` },
      card: { kind: "string", describe: "A Telegram card: its copy in the model's group (at_model), or one to attach (card)" },
      "card-file": { kind: "string", describe: "An edit: the changed card fields as a JSON object (null empties a field); - for stdin" },
      deadline: { kind: "string", describe: "An edit: the deadline YYYY-MM-DD (Moscow), or none" },
      "source-file": { kind: "string", describe: "An edit: the card's whole text as posted, from a file" },
      "if-version": { kind: "number", describe: "An edit: refuse it (409 version_changed) if the order changed since this version" },
      "on-behalf-of": { kind: "string", describe: "The Hub login on whose word the agent writes" },
    },
    hint: customHint,
    run: (client, values, deps, args) => client.agentCustomOrderUpdate({ params: { code: args[0]! }, body: customStepBody(values, deps) }),
  },
  {
    name: "custom cards",
    operation: "agentCustomCards",
    composite: true,
    summary:
      "COMPOSITE (several calls): what the reader of the models' groups found about cards, from --file {\"attach\": [{\"code\":"
      + " \"K-123\", \"telegramRef\": \"…\"}], \"unmatched\": [{\"telegramRef\", \"postedAt\", \"where\"}], \"complete\": true}: each"
      + " attach is the order's card from now on; the unmatched ones become the lead's matter «Карточка кастома без заказа»"
      + " (`complete`: the list is every unmatched card now, the others' matters close). Prints each call; any refused call"
      + " exits 4. Needs write:customs.",
    example: "hub custom cards --file cards.json",
    options: {
      file: { kind: "string", describe: "The cards as a JSON object (required): attach, unmatched, complete; - for stdin" },
    },
    hint: customHint,
    run: async (client, values, deps) => {
      const file = readJsonObject(values, deps, "file");
      if (file === undefined) throw new HubUsageError("--file is required: {attach: [...], unmatched: [...], complete}");
      const attach = Array.isArray(file.attach) ? file.attach as Array<{ code?: unknown; telegramRef?: unknown }> : [];
      const unmatched = Array.isArray(file.unmatched) ? file.unmatched : [];
      const report = checkedDraft(agentCustomCardsBodySchema, { cards: unmatched, complete: file.complete === true });
      const attached: Array<Record<string, unknown>> = [];
      let failed = 0;
      for (const one of attach) {
        if (typeof one.code !== "string" || typeof one.telegramRef !== "string") throw new HubUsageError("each attach is {code, telegramRef}");
        try {
          const answer = await client.agentCustomOrderUpdate({
            params: { code: one.code },
            body: checkedDraft(agentCustomOrderUpdateBodySchema, { action: "card", telegramRef: one.telegramRef }),
          });
          attached.push({ code: one.code, telegramRef: one.telegramRef, ok: true, outcome: answer.outcome });
        } catch (error) {
          failed += 1;
          attached.push({ code: one.code, telegramRef: one.telegramRef, ok: false, error: { ...compositeError(error), reason: refusalReason(error), hint: customHint(error as KernelApiError) } });
        }
      }
      let reported: Record<string, unknown> | null = null;
      if (report.cards.length > 0 || report.complete) {
        try {
          reported = { ok: true, ...(await client.agentCustomCards({ body: report })) };
        } catch (error) {
          failed += 1;
          reported = { ok: false, error: { ...compositeError(error), reason: refusalReason(error) } };
        }
      }
      return new HubCompositeResult({ attached, unmatched: reported }, failed, { calls: attached.length + (reported === null ? 0 : 1), failed });
    },
  },
];

// --- shift reports «со слов» (write:shift_reports) ---------------------------

const SHIFT_REPORT_CAPABILITY_HINT =
  "This key lacks write:shift_reports: the owner grants it to the key (dashboard, Система, Агенты и ключи)";

/** The one 403 an agent key with the capability gets here: the person's switch is off. */
const SHIFT_REPORT_SWITCH_OFF =
  "The person's switch «сдаёт смену в системе» is off: Hub takes no words for their report, nothing was written."
  + " Their report goes the old way: the post in «Отчётность»";

/** What a refusal of the shift reports' door means, and what to do. */
function shiftReportHint(error: { status: number | null; code: string | null }): string | null {
  const reason = refusalReason(error);
  if (error.status === 403 && error.code !== "forbidden") return SHIFT_REPORT_CAPABILITY_HINT;
  if (error.status === 403) return SHIFT_REPORT_SWITCH_OFF;
  if (error.status === 409 && reason === "sender_not_person") {
    return "sender_not_person: the message's sender is not this person (their Telegram id in the people registry). Write"
      + " only what the person said in their own message; a colleague's or a lead's message about them is not their word";
  }
  if (error.status === 400 && reason === "source_ref_required") return "A shift is handed in «со слов» only with the person's message: --message <link>";
  if (error.status === 400 && reason === "note_required") return "note_required: «моё» needs one line of why, in the person's words: --note";
  if (error.status === 400 && reason === "statement_not_allowed") {
    return "statement_not_allowed: a line of «Ваши продажи» (group mine) takes not_mine or share, a line of «Рядом» (group"
      + " near) and a sale added by hand take mine, rule takes any word back. Read the line's group in hub shift-report show";
  }
  if (error.status === 400 && (reason === "share_with_missing" || reason === "share_with_unknown")) {
    return `${reason}: «делим с…» names a colleague of the sale's page, one of \`colleagues\` in hub shift-report show`;
  }
  if (error.status === 404 && reason === "not_claimable") {
    return "not_claimable: this sale cannot be added by hand: it is not in hub shift-report claimable (another report of the"
      + " person holds it, its page is not theirs, or it is older than 7 days)";
  }
  if (error.status === 404) {
    return "Not found: no such person (Telegram id or code in the people registry) or shift, the person has no shift yet, a"
      + " page of the shift is outside this key's grant, or the sale is not a line of the draft (read hub shift-report show)";
  }
  return null;
}

/** `--statement`: the person's word on a line; `rule` takes it back (the rule's word stands). */
const SHIFT_REPORT_LINE_WORDS = [...SHIFT_REPORT_STATEMENTS, "rule"] as const;

/** A positive whole id from `--<name>`, or undefined. */
function readId(values: HubOptionValues, name: string): number | undefined {
  return values[name] === undefined ? undefined : requireId(values, name);
}

/** Whose words: the sender of the Telegram message (must be the person) and the message itself. */
function shiftReportWords(values: HubOptionValues, messageRequired: boolean) {
  return defined({
    telegramUserId: requireId(values, "sender"),
    sourceRef: messageRequired ? requireString(values, "message") : readString(values, "message"),
  });
}

/** `--share-with`: the colleague's user id, or their name as the report's `colleagues` print it (then the report is read first). */
async function shiftReportShareWith(client: KernelClient, raw: string, shiftId: number): Promise<number> {
  const text = raw.trim();
  if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0) return Number(text);
  const report = await client.agentShiftReport({ query: { shiftId } });
  const wanted = text.toLocaleLowerCase("ru");
  const found = report.colleagues.filter((one) => one.name.trim().toLocaleLowerCase("ru") === wanted);
  if (found.length === 1) return found[0]!.userId;
  throw new HubUsageError(
    found.length === 0
      ? `--share-with "${raw}" is none of this shift's colleagues: give one of theirs, by name or user id`
      : `--share-with "${raw}" names ${found.length} colleagues: give the user id`,
    { colleagues: report.colleagues },
  );
}

type ShiftReportAnswer = KernelOperationResponse<"agentShiftReport">;

/** One line over a report: whether Hub takes the person's words, and what stands now. */
function shiftReportNote(report: ShiftReportAnswer): string {
  const shift = `Shift ${report.shift.id} of ${report.shift.personName}, ${report.shift.reportDate}`;
  if (!report.enabled) {
    return `${shift}: the switch «сдаёт смену в системе» is off, so Hub takes no words for this report. It goes the old way:`
      + " the post in «Отчётность».";
  }
  const draft = report.view === null ? "" : ` The draft counts ${formatUsdFromMills(report.view.totalMills)} now («предварительно»: the rule and the person's words so far).`;
  const latest = report.latest;
  if (latest === null) {
    return `${shift}: not handed in yet.${draft} Hand it in on the person's word: hub shift-report submit --shift ${report.shift.id}`
      + " --sender <their Telegram id> --message <their message>.";
  }
  const handed = `handed in, version ${latest.version} at ${latest.submittedAt} (${latest.door}), ${formatUsdFromMills(latest.totalMills)}`;
  if (report.state === "open") return `${shift}: ${handed}, opened again since.${draft} submit makes version ${latest.version + 1}.`;
  const after = report.afterSubmission === null
    ? ""
    : ` After the hand-in ${report.afterSubmission.count} more sale(s) for ${formatUsdFromMills(report.afterSubmission.mills)}: submit again`
      + " to add them («Досдать»).";
  return `${shift}: ${handed}. The post for «Отчётность» is data.posts[].text, one per model.${after}`;
}

const SHIFT_REPORT_SENDER_OPTION: HubOption = {
  kind: "number",
  describe: "The Telegram id of the message's sender (required): must be the person's own (people registry), else 409 sender_not_person",
};
const SHIFT_REPORT_MESSAGE_OPTION: HubOption = {
  kind: "string",
  describe: "The person's message the words are in: https://t.me/c/<chat>/<msg>, or --message=<chat>:<msg> (with = when the chat id starts with -)",
};
const SHIFT_REPORT_SHIFT_OPTION: HubOption = { kind: "number", describe: "The shift's id, shift.id of hub shift-report show (required)" };

const SHIFT_REPORT_COMMANDS: HubCommand[] = [
  {
    name: "shift-report show",
    operation: "agentShiftReport",
    summary:
      "A person's shift report as they see it in Workboard, to write their words into it: `enabled` (their switch «сдаёт"
      + " смену в системе»; false: Hub takes no words, their report goes the old way, the post in «Отчётность»), the shift"
      + " (id, pages, reportDate, ongoing), `state` open | submitted, the versions handed in (`latest`, `versions`), the draft"
      + " (`view.lines`: «Ваши продажи» group mine and «Рядом» group near, each with the rule's `words`, the person's"
      + " `statement` and `note`, what it counts in `amountMills`, `added` for a «долёт» or a sale added by hand, and `facts`"
      + " for «почему»; `view.pages`, `view.totalMills`, `view.offPlatform`, `view.comment`), `afterSubmission` (sales after"
      + " the hand-in), `posts` (the newest version as the post for «Отчётность», one per model) and `colleagues` (whom"
      + " «делим с…» may name). The person by --sender (the Telegram id of whoever sent /smena, when it is their own report)"
      + " or --person; the shift by --shift, else the person's latest. Reading needs no message. Exit 0 — answered (read"
      + " `enabled` and the `note`); 4 — refused or no answer. Needs write:shift_reports.",
    example: "hub shift-report show --sender 700000111",
    options: {
      sender: { kind: "number", describe: "The person by their Telegram id (the sender of /smena)" },
      person: { kind: "string", describe: "Or the person by their code in the people registry" },
      shift: { kind: "number", describe: "The shift's id; absent — the person's latest shift" },
    },
    hint: shiftReportHint,
    run: async (client, values) => {
      const query = defined({ telegramUserId: readId(values, "sender"), person: readString(values, "person"), shiftId: readId(values, "shift") });
      if (Object.keys(query).length === 0) throw new HubUsageError("name the person (--sender or --person) or the shift (--shift)");
      const report = await client.agentShiftReport({ query });
      return new HubNotedResult(report, shiftReportNote(report));
    },
  },
  {
    name: "shift-report claimable",
    operation: "agentShiftReportClaimable",
    summary:
      "«Добавить → продажу»: the sales of the last 7 days the person may add to this report by hand, on the pages they may"
      + " open and this key's grant, held by no report of theirs: nobody's first («ничья», home nobody: it counts plainly"
      + " when added), then the newest; `words` says whose each is by the rule (one of someone else counts, marked disputed)."
      + " Add one with hub shift-report line --sale <transactionId> --statement mine --note \"<why, in their words>\"."
      + " Exit 0 — answered; 4 — refused (403: their switch is off; 409 sender_not_person) or no answer. Needs"
      + " write:shift_reports.",
    example: "hub shift-report claimable --shift 4512 --sender 700000111",
    options: {
      shift: SHIFT_REPORT_SHIFT_OPTION,
      sender: { kind: "number", describe: "The Telegram id of the person asking (required): must be the person's own" },
    },
    hint: shiftReportHint,
    run: (client, values) => client.agentShiftReportClaimable({
      query: { shiftId: requireId(values, "shift"), telegramUserId: requireId(values, "sender") },
    }),
  },
  {
    name: "shift-report line",
    operation: "agentShiftReportLineSet",
    summary:
      "Set the person's word on one sale of the draft, from their message: --statement not_mine («не моё», counts 0) or"
      + " share («делим с…», half the net, --share-with the colleague) on a line of «Ваши продажи»; mine («это моё», --note"
      + " with one line of why) on a line of «Рядом» or on a sale of hub shift-report claimable, which adds it to the report"
      + " (counted, disputed when the rule gives it to someone else); rule takes the word back. --note alone: send the"
      + " line's current word with it (rule when `statement` is null). Saved at once; the draft is recounted. Only the"
      + " person's own words in their own message, never the agent's inference. Exit 0 — saved; 4 — refused (403: their"
      + " switch is off; 409 sender_not_person; 400 statement_not_allowed, note_required, share_with_unknown; 404"
      + " not_claimable) or no answer. Needs write:shift_reports.",
    example: 'hub shift-report line --shift 4512 --sale 98765 --statement not_mine --note "PPV отправлял сменщик" --sender 700000111 --message https://t.me/c/2600000001/2001',
    options: {
      shift: SHIFT_REPORT_SHIFT_OPTION,
      sale: { kind: "number", describe: "The sale: transactionId of a line in show, or of a sale in claimable (required)" },
      statement: { kind: "string", describe: `The person's word (required): ${SHIFT_REPORT_LINE_WORDS.join(" | ")}` },
      "share-with": { kind: "string", describe: "With share: the colleague, by user id or by name as show's `colleagues` print it" },
      note: { kind: "string", describe: `A note on the line in the person's words, up to ${SHIFT_REPORT_NOTE_MAX} characters; required with mine` },
      sender: SHIFT_REPORT_SENDER_OPTION,
      message: SHIFT_REPORT_MESSAGE_OPTION,
    },
    hint: shiftReportHint,
    run: async (client, values) => {
      const shiftId = requireId(values, "shift");
      const transactionId = requireId(values, "sale");
      const word = requireEnum(values, "statement", SHIFT_REPORT_LINE_WORDS);
      const statement = word === "rule" ? null : word;
      const shareWith = readString(values, "share-with");
      if (statement === "share" && shareWith === undefined) throw new HubUsageError("--statement share names the colleague: --share-with <user id or name>");
      if (statement !== "share" && shareWith !== undefined) throw new HubUsageError("--share-with goes only with --statement share");
      const words = shiftReportWords(values, false);
      const draft = { shiftId, transactionId, statement, note: readString(values, "note"), ...words };
      checkedDraft(agentShiftReportLineBodySchema, defined(draft));
      const shareWithUserId = shareWith === undefined ? undefined : await shiftReportShareWith(client, shareWith, shiftId);
      return client.agentShiftReportLineSet({ body: checkedDraft(agentShiftReportLineBodySchema, defined({ ...draft, shareWithUserId })) });
    },
  },
  {
    name: "shift-report comment",
    operation: "agentShiftReportCommentSet",
    summary:
      "Set the draft's comment (for the next shift and the owner) to the person's own text, word for word; --text \"\""
      + ` empties it. Up to ${SHIFT_REPORT_COMMENT_MAX} characters, saved at once. Exit 0 — saved; 4 — refused (403: their switch`
      + " is off; 409 sender_not_person) or no answer. Needs write:shift_reports.",
    example: 'hub shift-report comment --shift 4512 --text "фан ждёт видео к пятнице" --sender 700000111 --message https://t.me/c/2600000001/2002',
    options: {
      shift: SHIFT_REPORT_SHIFT_OPTION,
      text: { kind: "string", describe: "The comment, the person's words (required)" },
      sender: SHIFT_REPORT_SENDER_OPTION,
      message: SHIFT_REPORT_MESSAGE_OPTION,
    },
    hint: shiftReportHint,
    run: (client, values) => {
      const comment = readString(values, "text");
      if (comment === undefined) throw new HubUsageError("--text is required: the person's comment (\"\" empties it)");
      return client.agentShiftReportCommentSet({
        body: checkedDraft(agentShiftReportCommentBodySchema, { shiftId: requireId(values, "shift"), comment, ...shiftReportWords(values, false) }),
      });
    },
  },
  {
    name: "shift-report off-platform",
    operation: "agentShiftReportOffPlatformAdd",
    summary:
      "Add «мимо площадки»: money that came past the platform (Telegram, crypto), with --amount in dollars, --from-whom and"
      + " --what-for, as the person said it. It waits for the owner and is never in the report's sums before the owner"
      + " confirms it; the post shows it in the comment as «ждёт подтверждения владельца». Exit 0 — added (`line`); 4 —"
      + " refused (403: their switch is off; 409 sender_not_person) or no answer. Needs write:shift_reports.",
    example: 'hub shift-report off-platform --shift 4512 --amount 50 --from-whom "фан из тг" --what-for "кастом" --sender 700000111 --message https://t.me/c/2600000001/2003',
    options: {
      shift: SHIFT_REPORT_SHIFT_OPTION,
      amount: { kind: "string", describe: "How much, in dollars (required): 50 or 49.99" },
      "from-whom": { kind: "string", describe: "From whom, as the person said it (required)" },
      "what-for": { kind: "string", describe: "What for (required)" },
      sender: SHIFT_REPORT_SENDER_OPTION,
      message: SHIFT_REPORT_MESSAGE_OPTION,
    },
    hint: shiftReportHint,
    run: (client, values) => {
      const amountMills = hubDollarsToMills(values, "amount", "positive");
      if (amountMills === undefined) throw new HubUsageError("--amount is required: dollars, 50 or 49.99");
      return client.agentShiftReportOffPlatformAdd({
        body: checkedDraft(agentShiftReportOffPlatformBodySchema, {
          shiftId: requireId(values, "shift"),
          amountMills,
          fromWhom: requireString(values, "from-whom"),
          whatFor: requireString(values, "what-for"),
          ...shiftReportWords(values, false),
        }),
      });
    },
  },
  {
    name: "shift-report submit",
    operation: "agentShiftReportSubmit",
    summary:
      "Hand the shift in «со слов»: the draft as it is now becomes the report's next version, door telegram, with the"
      + " person's message and its sender recorded. Never without both: --message (their message saying to hand it in) and"
      + " --sender (its sender, who must be the person). A shift still going may be handed in; again later makes the next"
      + " version («Досдать»). A day the ledger already paid is still handed in: Hub keeps the version and tells the owner"
      + " (this answer does not say whether the day was paid). The ledger reads the version itself. The answer is the"
      + " report as show prints it: give the person `posts[].text` for «Отчётность». Exit 0 — handed in; 4 — refused (403:"
      + " their switch is off; 409 sender_not_person) or no answer. Needs write:shift_reports.",
    example: "hub shift-report submit --shift 4512 --sender 700000111 --message https://t.me/c/2600000001/2004",
    options: {
      shift: SHIFT_REPORT_SHIFT_OPTION,
      sender: { kind: "number", describe: "The Telegram id of the message's sender (required): must be the person's own" },
      message: { kind: "string", describe: "The person's message to hand the shift in (required): https://t.me/c/<chat>/<msg>, or --message=<chat>:<msg> (with = when the chat id starts with -)" },
    },
    hint: shiftReportHint,
    run: async (client, values) => {
      const body = checkedDraft(agentShiftReportSubmitBodySchema, { shiftId: requireId(values, "shift"), ...shiftReportWords(values, true) });
      const report = await client.agentShiftReportSubmit({ body });
      const latest = report.latest;
      return new HubNotedResult(report, latest === null
        ? shiftReportNote(report)
        : `Handed in «со слов»: version ${latest.version}, ${formatUsdFromMills(latest.totalMills)}. The ledger reads this version`
          + " itself: save nothing else for this shift. Give the person data.posts[].text for «Отчётность» (one per model).");
    },
  },
];

// --- agent reports (write:reports) -----------------------------------------

const REPORT_CAPABILITY_HINT =
  "This key lacks write:reports: the owner grants it to the key (dashboard, Система, Агенты и ключи)";

function reportHint(error: { status: number | null; code: string | null }): string | null {
  return error.status === 403 && error.code !== "forbidden" ? REPORT_CAPABILITY_HINT : null;
}

/** `report put`'s body: the markdown from --file, the words from the flags. */
function reportBody(values: HubOptionValues, deps: HubRunDeps) {
  const validHours = readNumber(values, "valid-hours");
  return checkedDraft(agentReportPutBodySchema, defined({
    title: requireString(values, "title"),
    section: requireEnum(values, "section", AGENT_REPORT_SECTIONS),
    body: readTextFile(deps, requireString(values, "file")),
    teamLeads: readFlag(values, "team-leads") ? true : undefined,
    validHours,
  }));
}

const QUEUE_CAPABILITY_HINT =
  "This key lacks write:fan_queues: the owner grants it to the key (cli.js agent-keys:capabilities)";

function queueHint(error: { status: number | null; code: string | null }): string | null {
  return error.status === 403 && error.code !== "forbidden" ? QUEUE_CAPABILITY_HINT : null;
}

/** A JSON object from --file, with the flags laid over it. */
function queueBody(values: HubOptionValues, deps: HubRunDeps, over: Record<string, unknown>): Record<string, unknown> {
  const path = readString(values, "file");
  let fromFile: Record<string, unknown> = {};
  if (path !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readTextFile(deps, path));
    } catch {
      throw new HubUsageError(`--file ${path} is not JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HubUsageError(`--file ${path} is not a JSON object`);
    fromFile = parsed as Record<string, unknown>;
  }
  const rule = readString(values, "rule");
  let ruleValue: unknown;
  if (rule !== undefined) {
    try {
      ruleValue = JSON.parse(rule);
    } catch {
      throw new HubUsageError("--rule is not JSON");
    }
  }
  return { ...fromFile, ...defined({ rule: ruleValue }), ...defined(over) };
}

const QUEUE_RULE_OPTIONS: Record<string, HubOption> = {
  file: { kind: "string", describe: "A JSON body: {\"rule\": {…}} or {\"fans\": [{\"ref\", \"why\"}]} and, for create, the rest of the queue" },
  rule: { kind: "string", describe: "The rule as JSON, instead of the file's (spec §5: audience, fanWrote, lifetimeSpend, seen, …)" },
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
    name: "cross-spenders",
    operation: "agentCrossSpenders",
    summary:
      "The fans of a page's audience who paid other pages of its platform (by default the model's other pages:"
      + " lora-1 -> lora-2, lora-3) and never paid the page itself: whom a mass message of the page should leave"
      + " out. Largest source spend first; the summary counts the set, per source, and says when the audience was"
      + " walked. --all follows the cursors and prints the whole set (COMPOSITE). Needs read:datasets and read:money.",
    options: {
      "page-label": { kind: "string", describe: "The target page whose audience is read (required)" },
      audience: { kind: "string", describe: "followers | subscribers | any (default any)" },
      source: {
        kind: "list",
        describe: "A source page (repeatable or comma-separated), or all: every other page of the platform;"
          + " default: the other pages of the target's model",
      },
      "min-source-spend": { kind: "string", describe: "Dollars the fan paid the sources together, at least (default: any spend)" },
      "max-target-spend": {
        kind: "string",
        describe: "Dollars the fan paid the target page, at most (default 0: never paid it), or any",
      },
      all: { kind: "boolean", describe: "Follow every cursor and print the whole set in one document (COMPOSITE)" },
      ...PAGING_OPTIONS,
    },
    run: async (client, values) => {
      const pageLabel = requireString(values, "page-label");
      const cursor = readString(values, "cursor");
      const all = readFlag(values, "all");
      if (all && cursor !== undefined) {
        throw new HubUsageError("--all starts from the first page; it takes no --cursor");
      }
      const maxRaw = readString(values, "max-target-spend");
      const query = {
        ...defined({
          audience: readEnum(values, "audience", agentCrossSpendersAudienceEnum.options),
          sources: crossSpendersSources(values),
          minSourceSpendMills: hubDollarsToMills(values, "min-source-spend", "positive"),
          maxTargetSpendMills: maxRaw === "any" ? "any" as const : hubDollarsToMills(values, "max-target-spend", "non_negative"),
          limit: readNumber(values, "limit") ?? (all ? HUB_CROSS_SPENDERS_PAGE : undefined),
          cursor,
        }),
      };
      const first = await client.agentCrossSpenders({ params: { pageLabel }, query });
      return all ? crossSpendersAll(client, first, pageLabel) : first;
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
      // Its bounds come from the contract (contract.ts, hubOptionHelp).
      limit: { kind: "number", describe: "Maximum matches" },
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
      "Draft a publication on a page: a person approves it, or this key when it has approve:publications"
      + " (publication-approve, on the owner's word in the chat). The body comes from --file and/or"
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
      // Its bounds come from the contract (contract.ts, hubOptionHelp).
      limit: { kind: "number", describe: "Maximum publications" },
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
    summary: "One publication of your pages: a draft's findings re-checked now, and its status journal. An OnlyFans"
      + " vault album carries albumRun, and the note says it in one line: the step, files in of all, the file going up,"
      + " credits spent of the price, the files that did not land by group.",
    options: {
      id: { kind: "number", describe: "The publication id (required)" },
    },
    hint: publicationHint,
    run: async (client, values) => {
      const publication = await client.agentPublicationGet({ params: { id: requireId(values, "id") } });
      const progress = albumRunLine(publication.albumRun ?? null);
      return progress === null ? publication : new HubNotedResult(publication, progress);
    },
  },
  {
    name: "publication-targets",
    operation: "agentPublicationTargets",
    summary:
      "The page's Fansly walls and subscription tiers by name (no prices): what a draft's --wall and"
      + " --tier name. Needs write:publication_drafts.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
    },
    hint: publicationHint,
    run: (client, values) => client.agentPublicationTargets({ params: { pageLabel: requireString(values, "page-label") } }),
  },
  {
    name: "publication-changes",
    operation: "agentPublicationChanges",
    summary:
      "The publications this key drafted, on its pages, changed at or after --since, oldest change first: status,"
      + " its reason, the platform's post or album, times. Keep the greatest updatedAt and ask again from it minus"
      + " an overlap. Needs write:publication_drafts.",
    options: {
      since: { kind: "string", describe: "Changed at or after this time (RFC 3339); left out — from the first one" },
      ...PAGING_OPTIONS,
    },
    hint: publicationHint,
    run: (client, values) => client.agentPublicationChanges({
      query: defined({
        since: readString(values, "since"),
        limit: readNumber(values, "limit"),
        cursor: readString(values, "cursor"),
      }),
    }),
  },
  {
    name: "publication-cancel",
    operation: "agentPublicationCancel",
    summary:
      "Cancel a publication this key drafted while Hub has not handed it to the platform (a draft or an approved"
      + " one). Later a cancel no longer applies (409 publication_handed_to_platform): publication-withdraw takes it"
      + " off the schedule. Needs write:publication_drafts.",
    options: {
      id: { kind: "number", describe: "The publication id (required)" },
    },
    hint: publicationHint,
    run: (client, values) => client.agentPublicationCancel({ params: { id: requireId(values, "id") } }),
  },
  {
    name: "publication-withdraw",
    operation: "agentPublicationWithdraw",
    summary:
      "Take a Hub post of your pages off the platform's schedule, any Hub post there, whoever drafted it — the"
      + " owner's «Снять», with the same refusals (only a scheduled post, 15 minutes or more before its time, the"
      + " page not stopped, one cancel per post). Fansly answers accepted and the result comes as the post's status"
      + " within minutes (publication-get); OnlyFans answers its outcome. Needs withdraw:publications.",
    options: {
      id: { kind: "number", describe: "The publication id (required)" },
    },
    hint: withdrawHint,
    run: async (client, values) => {
      const answer = await client.agentPublicationWithdraw({ params: { id: requireId(values, "id") } });
      return answer.results.some((result) => result.outcome === "accepted")
        ? new HubNotedResult(answer, PUBLICATION_WITHDRAW_ACCEPTED_NOTE)
        : answer;
    },
  },
  {
    name: "post-withdraw",
    operation: "agentPostWithdraw",
    summary:
      "Take any post of your page off the platform's schedule by its id (postRef from publication-queue) — one put"
      + " there by hand too. Only a post Hub's own read of the page's schedule, an hour old at most, shows waiting"
      + " (refresh the queue first), 15 minutes or more before its time. A Hub post goes through its publication's"
      + " withdrawal. One command per post: asking again sends nothing and answers where it stands. Never a"
      + " deletion. Needs withdraw:publications.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      "post-ref": { kind: "string", describe: "The platform's post id: postRef of the schedule entry (required)" },
    },
    hint: withdrawHint,
    run: async (client, values) => notedPostAnswer(await client.agentPostWithdraw({
      params: { pageLabel: requireString(values, "page-label"), postRef: requireString(values, "post-ref") },
    })),
  },
  {
    name: "post-delete",
    operation: "agentPostDelete",
    summary:
      "Delete a published post of your page by its id — ONLY on the owner's «да» for that very post. Only a post Hub"
      + " has among the page's own posts, not in its schedule (that is post-withdraw). A daily ceiling per key; the"
      + " reason goes to the owner's audit. One command per post: asking again sends nothing and answers where it"
      + " stands; unknown is never sent again. Needs delete:posts.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      "post-ref": { kind: "string", describe: "The platform's post id (required)" },
      reason: { kind: "string", describe: "Why, with whose «да», e.g. «Дима 11.11: удалить, нарезка из кастома» (required, 3-300 chars)" },
    },
    hint: deleteHint,
    run: async (client, values) => notedPostAnswer(await client.agentPostDelete({
      params: { pageLabel: requireString(values, "page-label"), postRef: requireString(values, "post-ref") },
      body: { reason: requireString(values, "reason") },
    })),
  },
  {
    name: "publication-queue",
    operation: "agentPublicationQueue",
    summary:
      "The page's own schedule on the platform as Hub last read it: Hub's posts in it (publicationId) and the ones"
      + " put there by hand (publicationId null), when it was read (readAt), whether it was complete and fresh."
      + " --refresh first asks for a fresh read (it lands within a minute or two; on OnlyFans it spends"
      + " OnlyFansAPI credits). Needs write:publication_drafts or withdraw:publications.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      refresh: { kind: "boolean", describe: "Ask for a fresh read first; this answer is still the last one" },
    },
    hint: withdrawHint,
    run: async (client, values) => {
      const params = { pageLabel: requireString(values, "page-label") };
      if (!readFlag(values, "refresh")) return client.agentPublicationQueue({ params });
      const asked = await client.agentPublicationQueueRefresh({ params });
      return new HubNotedResult(
        await client.agentPublicationQueue({ params }),
        `A fresh read was asked for at ${asked.requestedAt}; this is the last one. Ask again in a minute or two: the`
          + " fresh one has a readAt after that time.",
      );
    },
  },
  {
    name: "publication-approve",
    operation: "agentPublicationApprove",
    summary:
      "Approve drafts of your pages in order — only on the owner's «да» in the chat for exactly these drafts."
      + " Each is checked again and refused on a blocking finding, a newer version or a status that is not a draft."
      + " Needs approve:publications, or approve:vault_albums for a vault album (any other kind is refused:"
      + " kind_not_allowed).",
    options: {
      id: { kind: "number", describe: "The publication id (required)" },
      version: { kind: "number", describe: "The version the owner saw (required)" },
    },
    hint: publicationHint,
    run: (client, values) => {
      const version = readNumber(values, "version");
      if (typeof version !== "number") throw new HubUsageError("--version is required: the version the owner saw");
      return client.agentPublicationApprove({ body: { items: [{ id: requireId(values, "id"), version }] } });
    },
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
  {
    name: "publication-file-upload",
    operation: "agentPublicationFileUpload",
    composite: true,
    summary:
      "COMPOSITE. Upload photos and videos from disk into Hub for a page's model, for a draft's --media file:<id>: each"
      + " file's SHA-256 read first and Hub asked which of them it holds — those are not sent again (Hub keeps them 7"
      + " more days); the others streamed whole, --parallel at a time, a lost network waited for up to 15 minutes per"
      + " file (the same bytes answer the same file, so a retry never makes a second one). A file Hub would refuse"
      + " (HEIC, not a photo or video, empty) stops the call before any upload. Progress goes to stderr. Needs"
      + " write:publication_drafts.",
    arguments: { name: "<path…>", describe: "The files (a shell glob works); each keeps its own name in Hub", min: 1, max: null },
    options: {
      "page-label": { kind: "string", describe: "The page whose model the files are for (required)" },
      ...UPLOAD_OPTIONS,
    },
    hint: publicationHint,
    run: async (client, values, deps, args) => {
      const pageLabel = requireString(values, "page-label");
      const parallel = readParallel(values);
      const paths = [...new Set(args.map((path) => resolve(path)))];
      const checks = await Promise.all(paths.map((path) => checkHubFile(deps.files, path)));
      const refused = checks.flatMap((check, index) => (check.ok ? [] : [{
        name: paths[index]!,
        why: check.kind === "folder" ? "a folder: name its files, or draft an album with vault-album-draft" : check.why,
      }]));
      if (refused.length > 0) throw refusedFiles(refused, "");
      // The key's right and the page, before the first byte.
      await client.agentPublicationTargets({ params: { pageLabel } });
      const items = checks.flatMap((check) => (check.ok ? [check.item] : []));
      const { outcomes, attempts, lookups } = await sendHubFiles({
        pageLabel, items: await hashedFiles(deps, items), parallel, upload: deps.upload, lookup: hubLookup(client, pageLabel),
        sleep: deps.sleep, now: deps.now, progress: deps.progress,
      });
      const totals = uploadsOf(outcomes);
      return new HubCompositeResult({
        pageLabel,
        files: outcomes.map((outcome) => ({
          path: outcome.item.path, name: outcome.item.name, size: formatHubBytes(outcome.item.byteSize), ...uploadResult(outcome, true),
        })),
        totals,
      }, totals.failed, { calls: 1 + lookups + attempts, failed: totals.failed });
    },
  },
  {
    name: "vault-album-draft",
    operation: "agentPublicationCreate",
    composite: true,
    summary:
      "COMPOSITE. A Fansly or OnlyFans vault album from a pack's folder: its photos and videos (not subfolders, not hidden"
      + " files) in name order, IMG_2 before IMG_10, the first on top of the album; uploaded into Hub as"
      + " publication-file-upload does, then drafted as one vault_album. A folder holding the same file twice stops before"
      + " any upload; the same command again after a break sends only the files Hub lacks. --dry-run lists the order,"
      + " names, sizes, totals and the files Hub holds already, and uploads nothing: show that to the owner first. On"
      + " OnlyFans it also asks Hub's price (agentVaultAlbumQuote, waiting up to 3 minutes for a fresh read of the page's"
      + " albums): credits and dollars, the albums' day ceiling, spent, left, the balance, the album found / new / similar"
      + " titles, the files over the link limit (byHand: never uploaded nor drafted, added by hand), the files already on"
      + " the page, the order when it is not the folder's, whether sending is on; the real run needs --max-credits and"
      + " stops before any byte when the price is above it, or when only a similar title exists (--album-ref or"
      + " --new-album). A person approves the draft: the owner in Hub, or publication-approve only on the owner's «да» in"
      + " the chat. Needs write:publication_drafts.",
    arguments: { name: "<folder>", describe: "The pack's folder", min: 1, max: 1 },
    options: {
      "page-label": { kind: "string", describe: "The Fansly or OnlyFans page (required); one page per command" },
      title: {
        kind: "string",
        describe: `The album's title (required; one line, at most ${PUBLICATION_VAULT_ALBUM_TITLE_MAX} characters): the`
          + " page's album with this title gets the files, otherwise Hub makes one",
      },
      "publish-at": {
        kind: "string",
        describe: "When Hub sends it, RFC 3339 with an offset (default: when the draft is made); not sent within 12 hours"
          + " of it, it ends missed",
      },
      "dry-run": {
        kind: "boolean",
        describe: "Only check the folder and the page, compare the files with what Hub holds and list the album; nothing is"
          + " uploaded or drafted",
      },
      "max-credits": {
        kind: "number",
        describe: "OnlyFans, required without --dry-run: the price in credits the person said «да» to; a higher price stops"
          + " the run before any byte goes to Hub",
      },
      "album-ref": {
        kind: "string",
        describe: "The page's album by its id (albumFound.similar / albumFound.albumRef of the dry run): the files go into it",
      },
      "new-album": {
        kind: "boolean",
        describe: "OnlyFans: the title is new on purpose, beside the similar titles the dry run named (on the person's word)",
      },
      ...UPLOAD_OPTIONS,
      "idempotency-key": {
        kind: "string",
        describe: "A uuid (default: one made from the page, the title and the files, so the same command again answers"
          + " the first draft, or 409 when only the time differs)",
      },
    },
    hint: publicationHint,
    run: (client, values, deps, args) => draftVaultAlbum(client, values, deps, args[0]!),
  },
  {
    name: "media-look",
    operation: "agentMediaLookCreate",
    summary:
      "Look at a file of the page on Fansly: a post in its schedule or a published one (--post-ref, or a Hub"
      + " publication scheduled or published), or a file of its own vault (--media-ref): frames ≤ 512 px — a video's"
      + " sample (one per second, or evenly spaced: what is between frames is not seen) or its cover, a photo"
      + " downscaled. Through the page at its pace: one request for a scheduled post, two (a read, then the image)"
      + " for a published post or a vault file — one look against the page's daily limit; a fresh look of the same"
      + " file answers cached and costs nothing. While it is queued it is read again (media-look-get) up to --wait"
      + " seconds. --out DIR writes the frames as JPEGs and prints their paths. Needs look:media.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      "publication-id": { kind: "number", describe: "A Hub publication of the page, scheduled or published (or --post-ref, --media-ref)" },
      "post-ref": { kind: "string", describe: "A post of the page, scheduled or published, its Fansly id (or --publication-id, --media-ref)" },
      "media-ref": { kind: "string", describe: "A file of the page's own vault, its Fansly media id (or --publication-id, --post-ref)" },
      index: { kind: "number", describe: "Which of the post's files, 0-based, an album's files in its order (default 0); not with --media-ref" },
      cover: { kind: "boolean", describe: "A video's cover instead of its frames" },
      fresh: { kind: "boolean", describe: "Look again even when a fresh look of the file is kept (costs one look)" },
      "no-frames": { kind: "boolean", describe: "The frames' facts only, no pictures" },
      out: { kind: "string", describe: "Write the frames as JPEGs under this folder: DIR/<page>/<post, publication or media>/f000_t00000ms.jpg" },
      wait: { kind: "number", describe: `Seconds to keep reading a queued look (default ${MEDIA_LOOK_WAIT_SECONDS}; 0: answer at once)` },
    },
    hint: mediaLookHint,
    run: async (client, values, deps) => {
      const pageLabel = requireString(values, "page-label");
      const publicationId = readNumber(values, "publication-id");
      const postRef = readString(values, "post-ref");
      const mediaRef = readString(values, "media-ref");
      if ([publicationId, postRef, mediaRef].filter((target) => target !== undefined).length !== 1) {
        throw new HubUsageError("name exactly one of --publication-id, --post-ref, --media-ref");
      }
      if (mediaRef !== undefined && readNumber(values, "index") !== undefined) {
        throw new HubUsageError("a vault file has no index: --media-ref takes no --index");
      }
      const frames = mediaLookFramesMode(values);
      const waitSeconds = readNumber(values, "wait") ?? MEDIA_LOOK_WAIT_SECONDS;
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > MEDIA_LOOK_WAIT_MAX_SECONDS) {
        throw new HubUsageError(`--wait must be 0 to ${MEDIA_LOOK_WAIT_MAX_SECONDS} seconds`);
      }
      let look = await client.agentMediaLookCreate({
        params: { pageLabel },
        body: {
          ...(publicationId === undefined ? {} : { publicationId: requireId(values, "publication-id") }),
          ...(postRef === undefined ? {} : { postRef }),
          ...(mediaRef === undefined ? {} : { mediaRef }),
          index: readNumber(values, "index") ?? 0,
          cover: readFlag(values, "cover"),
          fresh: readFlag(values, "fresh"),
          frames,
        },
      });
      const started = deps.now();
      while (look.status === "queued" && deps.now() - started + MEDIA_LOOK_POLL_SECONDS * MS_PER_SECOND <= waitSeconds * MS_PER_SECOND) {
        await deps.sleep(MEDIA_LOOK_POLL_SECONDS * MS_PER_SECOND);
        look = await client.agentMediaLookGet({ params: { pageLabel, lookId: look.lookId }, query: { frames } });
      }
      return mediaLookPrinted(look, pageLabel, readString(values, "out"), deps);
    },
  },
  {
    name: "media-look-get",
    operation: "agentMediaLookGet",
    summary:
      "A media look of the page by its id: its status and frames, finished now when the page's engine has answered"
      + " since. --out DIR writes the frames as JPEGs and prints their paths. Needs look:media.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      "look-id": { kind: "number", describe: "The look's id (required)" },
      "no-frames": { kind: "boolean", describe: "The frames' facts only, no pictures" },
      out: { kind: "string", describe: "Write the frames as JPEGs under this folder: DIR/<page>/<post or publication>/f000_t00000ms.jpg" },
    },
    hint: mediaLookHint,
    run: async (client, values, deps) => {
      const pageLabel = requireString(values, "page-label");
      const look = await client.agentMediaLookGet({
        params: { pageLabel, lookId: requireId(values, "look-id") },
        query: { frames: mediaLookFramesMode(values) },
      });
      return mediaLookPrinted(look, pageLabel, readString(values, "out"), deps);
    },
  },
  {
    name: "queue-preview",
    operation: "agentFanQueuePreview",
    summary:
      "How many fans of a page a rule (or a list) puts in a queue, what it leaves out and why, the rule in Hub's own"
      + " words and a few fans: show this to the person who asked BEFORE queue-create. Nothing is written."
      + " Needs write:fan_queues.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      ...QUEUE_RULE_OPTIONS,
      "daily-limit": { kind: "number", describe: "The planned sends per day: the answer says how many days the queue lasts" },
    },
    hint: queueHint,
    run: (client, values, deps) => client.agentFanQueuePreview({
      params: { pageLabel: requireString(values, "page-label") },
      body: checkedDraft(agentFanQueuePreviewBodySchema, queueBody(values, deps, { dailyLimit: readNumber(values, "daily-limit") })),
    }),
  },
  {
    name: "queue-create",
    operation: "agentFanQueueCreate",
    summary:
      "Create a fan queue on a page ONLY after the «да» of the person who asked, for exactly what queue-preview showed."
      + " --requested-by is their Hub username; a fan already in an open queue of the page is left out."
      + " Repeat-safe by --idempotency-key. Needs write:fan_queues.",
    options: {
      "page-label": { kind: "string", describe: "The page (required)" },
      ...QUEUE_RULE_OPTIONS,
      name: { kind: "string", describe: "The queue's name the chatters see" },
      goal: { kind: "string", describe: "The goal in plain words, shown on the card" },
      "requested-by": { kind: "string", describe: "The Hub username of the person who asked (required)" },
      "idempotency-key": { kind: "string", describe: "Required: the same key answers the same queue" },
    },
    hint: queueHint,
    run: (client, values, deps) => {
      const body = queueBody(values, deps, {
        name: readString(values, "name"),
        goal: readString(values, "goal"),
        requestedBy: readString(values, "requested-by"),
        idempotencyKey: readString(values, "idempotency-key"),
      });
      if (typeof body.requestedBy !== "string") throw new HubUsageError("--requested-by is required: whose word creates the queue");
      if (typeof body.idempotencyKey !== "string") throw new HubUsageError("--idempotency-key is required: it makes the create repeat-safe");
      return client.agentFanQueueCreate({
        params: { pageLabel: requireString(values, "page-label") },
        body: checkedDraft(agentFanQueueCreateBodySchema, body),
      });
    },
  },
  {
    name: "queue-list",
    operation: "agentFanQueueList",
    summary: "The fan queues of your pages: today's sends by person, what is left and for how many days. Needs write:fan_queues.",
    options: {
      "page-label": { kind: "string", describe: "Only this page" },
      status: { kind: "string", describe: "open (default: active and paused) | active | paused | done | all" },
    },
    hint: queueHint,
    run: (client, values) => client.agentFanQueueList({
      query: defined({
        pageLabel: readString(values, "page-label"),
        status: readEnum(values, "status", ["open", "active", "paused", "done", "all"] as const),
      }),
    }),
  },
  {
    name: "queue-show",
    operation: "agentFanQueueGet",
    summary:
      "One fan queue with its results: sent, answered within 72 hours, bought within 7 days, spent within 30 days,"
      + " by person, and skips and drops by reason. Needs write:fan_queues.",
    options: {
      id: { kind: "number", describe: "The queue id (required)" },
      ...WINDOW_OPTIONS,
    },
    hint: queueHint,
    run: (client, values) => client.agentFanQueueGet({
      params: { queueId: requireId(values, "id") },
      query: defined({ from: readString(values, "from"), to: readString(values, "to") }),
    }),
  },
  {
    name: "queue-edit",
    operation: "agentFanQueueUpdate",
    summary:
      "Change a fan queue on the word of --requested-by (its asker, the owner or a team lead): --status paused | active"
      + " | done, limits, people, or --move-from/--move-to to hand a person's untouched fans to another (pool: --move-to"
      + " pool). Needs write:fan_queues.",
    options: {
      id: { kind: "number", describe: "The queue id (required)" },
      file: { kind: "string", describe: "A JSON change body (the flags override it)" },
      "requested-by": { kind: "string", describe: "The Hub username of the person who asked (required)" },
      status: { kind: "string", describe: "active | paused | done" },
      "per-person": { kind: "number", describe: "A person's portion per day" },
      "daily-limit": { kind: "number", describe: "The page's sends per day" },
      "add-person": { kind: "list", describe: "A Hub username to add (repeatable)" },
      "remove-person": { kind: "list", describe: "A Hub username to remove (repeatable)" },
      "move-from": { kind: "string", describe: "People queue: whose untouched fans move" },
      "move-to": { kind: "string", describe: "To whom (a Hub username) or pool" },
      "move-count": { kind: "number", describe: "How many (default all)" },
    },
    hint: queueHint,
    run: (client, values, deps) => {
      const from = readString(values, "move-from");
      const to = readString(values, "move-to");
      if ((from === undefined) !== (to === undefined)) throw new HubUsageError("--move-from and --move-to go together");
      const body = queueBody(values, deps, {
        requestedBy: readString(values, "requested-by"),
        status: readEnum(values, "status", ["active", "paused", "done"] as const),
        perPerson: readNumber(values, "per-person"),
        dailyLimit: readNumber(values, "daily-limit"),
        addPeople: readList(values, "add-person"),
        removePeople: readList(values, "remove-person"),
        move: from === undefined ? undefined : defined({ from, to: to === "pool" ? null : to, count: readNumber(values, "move-count") }),
      });
      if (typeof body.requestedBy !== "string") throw new HubUsageError("--requested-by is required: whose word changes the queue");
      return client.agentFanQueueUpdate({ params: { queueId: requireId(values, "id") }, body: checkedDraft(agentFanQueueUpdateBodySchema, body) });
    },
  },
  {
    name: "queue-add",
    operation: "agentFanQueueAppend",
    summary:
      "Add fans to a fan queue by a rule or a list, on the word of --requested-by; fans already queued on the page are"
      + " left out. Needs write:fan_queues.",
    options: {
      id: { kind: "number", describe: "The queue id (required)" },
      ...QUEUE_RULE_OPTIONS,
      "requested-by": { kind: "string", describe: "The Hub username of the person who asked (required)" },
    },
    hint: queueHint,
    run: (client, values, deps) => {
      const body = queueBody(values, deps, { requestedBy: readString(values, "requested-by") });
      if (typeof body.requestedBy !== "string") throw new HubUsageError("--requested-by is required: whose word adds the fans");
      return client.agentFanQueueAppend({ params: { queueId: requireId(values, "id") }, body: checkedDraft(agentFanQueueAppendBodySchema, body) });
    },
  },
  {
    name: "shift-review",
    operation: "agentShiftReview",
    summary:
      "«Разбор смены» of one shift on this key's pages, and the «Обучалка» shift audit's numbers counted from it"
      + " (`numbers`): the shift of --user-id (a Hub login) or --person (a people registry code) that holds --at."
      + " Needs read:team and read:money; message texts with read:messages. The AI's own texts are never in it.",
    options: {
      at: { kind: "string", describe: "A moment inside the shift, ISO with an offset (required): 2026-11-11T09:00:00+03:00" },
      "user-id": { kind: "number", describe: "The Hub login whose shift it is" },
      person: { kind: "string", describe: "Or the person's code (people registry): their login whose shift holds --at" },
    },
    run: (client, values) => {
      const userId = readNumber(values, "user-id");
      const person = readString(values, "person");
      if ((userId === undefined) === (person === undefined)) throw new HubUsageError("give exactly one of --user-id and --person");
      return client.agentShiftReview({ query: { at: requireString(values, "at"), ...defined({ userId, person }) } });
    },
  },
  {
    name: "fan-watch",
    operation: "agentFanWatch",
    summary:
      "Watched fans' new messages on this key's pages and when the page last wrote to them: one watch by --page,"
      + " --username, --since (and --archived-after, the newest archivedAt already seen), or many from --file"
      + " ({\"watches\": [...]}). Needs read:messages; tips with read:money.",
    options: {
      file: { kind: "string", describe: "A JSON body {\"watches\": [{pageLabel, username, since, archivedAfter?}]}" },
      page: { kind: "string", describe: "The page's label" },
      username: { kind: "string", describe: "The fan's username on the platform" },
      since: { kind: "string", describe: "The watch's start, ISO with an offset" },
      "archived-after": { kind: "string", describe: "Only messages the archive took after this (ISO with an offset)" },
    },
    run: (client, values, deps) => {
      const file = readString(values, "file");
      const body = file !== undefined
        ? readJsonFile(deps, file)
        : { watches: [defined({
          pageLabel: requireString(values, "page"), username: requireString(values, "username"), since: requireString(values, "since"),
          archivedAfter: readString(values, "archived-after"),
        })] };
      return client.agentFanWatch({ body: checkedDraft(agentFanWatchBodySchema, body) });
    },
  },
  {
    name: "sale-context",
    operation: "agentSaleContext",
    summary:
      "For a shift report's check: each sale's fan, the PPV it bought (sender, time; its text with read:messages) and"
      + " who wrote to the fan in the 48 hours, the 7 days and last in the 60 days before it. Sales by Hub's id"
      + " (--sale-ref, repeatable) or from --file ({\"sales\": [{saleRef} | {pageLabel, transactionRef}]}). Needs"
      + " read:team and read:money.",
    options: {
      file: { kind: "string", describe: "A JSON body {\"sales\": [...]}: Hub's saleRef, or a page's platform transactionRef" },
      "sale-ref": { kind: "list", describe: "Hub's id of a sale (repeatable)" },
    },
    run: (client, values, deps) => {
      const file = readString(values, "file");
      const body = file !== undefined
        ? readJsonFile(deps, file)
        : { sales: (readList(values, "sale-ref") ?? []).map((saleRef) => ({ saleRef })) };
      return client.agentSaleContext({ body: checkedDraft(agentSaleContextBodySchema, body) });
    },
  },
  {
    name: "sale-chain",
    operation: "agentSaleChain",
    summary:
      "From one sale, its chain of money: whose it is (the rule's home and why, the owner's decision, an open claim), the"
      + " shift, the report of that day (Hub's handed-in version, else the ledger's post), the ledger's accrual and payout"
      + " as states. A sale by Hub's id (a bare word) or by --page and --ref (the platform's transaction id). Never a pay"
      + " sum: the ledger is the door for pay. Needs read:team and read:money.",
    example: "hub sale-chain 7744520",
    options: {
      page: { kind: "string", describe: "With --ref: the sale's page label" },
      ref: { kind: "string", describe: "With --page: the platform's transaction id" },
    },
    arguments: { name: "<transactionId>", describe: "Hub's id of the sale (transactions.id)", min: 0, max: 1 },
    run: (client, values, _deps, args) => {
      const page = readString(values, "page");
      const ref = readString(values, "ref");
      const saleRef = args[0];
      if ((saleRef === undefined) === (page === undefined || ref === undefined)) {
        throw new HubUsageError("name the sale: its Hub id as a bare word, or --page and --ref");
      }
      if (saleRef !== undefined && !/^\d{1,19}$/.test(saleRef)) throw new HubUsageError("the sale's Hub id is digits");
      return client.agentSaleChain({ query: saleRef !== undefined ? { saleRef } : { pageLabel: page!, transactionRef: ref! } });
    },
  },
  {
    name: "report put",
    operation: "agentReportPut",
    summary:
      "Publish a page people read in the app, by its slug (a bare word: traffic), from a markdown file: the owner reads"
      + " it (`traffic` is Трафик → Сводка; every page is in Система → Отчёты агентов), team leads too with --team-leads."
      + " The same slug again replaces the page; the same text keeps its version. Needs write:reports.",
    arguments: { name: "slug", describe: "the page's slug: lowercase letters, digits and hyphens", min: 1, max: 1 },
    options: {
      title: { kind: "string", describe: "The page's title (required)" },
      section: { kind: "string", describe: `Where it belongs (required): ${AGENT_REPORT_SECTIONS.join(" | ")}` },
      file: { kind: "string", describe: "The markdown file (required), up to 256 KB: headings, lists, tables, links, code" },
      "valid-hours": { kind: "number", describe: "The page is shown as stale this many hours after publishing" },
      "team-leads": { kind: "boolean", describe: "Team leads read it too (default: the owner only)" },
    },
    hint: reportHint,
    run: (client, values, deps, args) => client.agentReportPut({ params: { slug: args[0]! }, body: reportBody(values, deps) }),
  },
  {
    name: "report list",
    operation: "agentReportList",
    summary: "The published pages without their text: slug, title, section, version, when, by which key, stale or not."
      + " Needs write:reports.",
    options: {},
    hint: reportHint,
    run: (client) => client.agentReportList(),
  },
  ...MATTER_COMMANDS,
  ...CUSTOM_COMMANDS,
  ...SHIFT_REPORT_COMMANDS,
];

/** A command by its words: one (`threads`) or two (`report put`). */
export function findHubCommand(name: string): HubCommand | undefined {
  return HUB_COMMANDS.find((command) => command.name === name);
}
