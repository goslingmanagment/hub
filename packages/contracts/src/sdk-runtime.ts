import type { z } from "zod";

import { routeSchemas } from "./routes.ts";

// Kernel Stage 20: the @kernel/sdk runtime. The generated package
// (packages/sdk) contains ONLY machine-written artifacts — the operations
// manifest, the contract hash, and thin re-exports; every moving part lives
// here, typed directly off the Zod contract registry (imported, never
// duplicated), so request/response types and runtime validation cannot drift
// from what the server enforces.

export interface KernelOperationDef {
  method: string;
  path: string;
}

type Schemas = typeof routeSchemas;
export type KernelOperationKey = keyof Schemas & string;

/**
 * Operations without a plain request/JSON-response shape. The webhook is
 * HMAC-authenticated server intake; the two streams are SSE (dedicated
 * helpers); the read gateway is a wildcard proxy (passthrough helper); the
 * ledger CSV returns text/csv. All remain reachable via `client.raw(...)`.
 */
export const SDK_EXCLUDED_OPERATIONS = [
  "ofapiWebhookReceive",
  "eventsStream",
  "eventsV2Stream",
  "aiGatewayStream",
  "ofapiReadGateway",
  "adminOfapiCreditsLedgerCsv",
] as const;
export type KernelSdkExcludedKey = (typeof SDK_EXCLUDED_OPERATIONS)[number];
export type KernelSdkMethodKey = Exclude<KernelOperationKey, KernelSdkExcludedKey>;

type InputOf<S> = S extends z.ZodType ? z.input<S> : never;
type OutputOf<S> = S extends z.ZodType ? z.output<S> : never;

type SuccessStatus = 200 | 201 | 202 | 204;

export type KernelOperationRequest<K extends KernelOperationKey> =
  (Schemas[K] extends { params: infer P } ? { params: InputOf<P> } : object) &
  (Schemas[K] extends { querystring: infer Q } ? { query: InputOf<Q> } : object) &
  (Schemas[K] extends { body: infer B } ? { body: InputOf<B> } : object);

export type KernelOperationResponse<K extends KernelOperationKey> =
  Schemas[K] extends { response: infer R }
    ? OutputOf<R[Extract<keyof R, SuccessStatus>]>
    : never;

type HasRequestFields<K extends KernelOperationKey> =
  Schemas[K] extends { params: unknown } ? true
    : Schemas[K] extends { querystring: unknown } ? true
      : Schemas[K] extends { body: unknown } ? true
        : false;

export type KernelClient = {
  [K in KernelSdkMethodKey]: HasRequestFields<K> extends true
    ? (input: KernelOperationRequest<K>) => Promise<KernelOperationResponse<K>>
    : () => Promise<KernelOperationResponse<K>>;
} & {
  /**
   * Escape hatch: send any operation (including the excluded ones) with the
   * manifest's method/path and the client's auth plumbing, and get the raw
   * Response back — no validation, no JSON assumption.
   */
  raw(key: KernelOperationKey, input?: {
    params?: Record<string, string | number>;
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<Response>;
};

export type KernelErrorCategory =
  | "auth"
  | "validation"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "server"
  | "network"
  | "contract";

export class KernelApiError extends Error {
  constructor(
    message: string,
    readonly category: KernelErrorCategory,
    readonly status: number | null,
    readonly code: string | null,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "KernelApiError";
  }
}

function categoryForStatus(status: number): KernelErrorCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "validation";
}

export interface KernelClientOptions {
  baseUrl: string;
  auth?:
    | { mode: "cookie" }
    | { mode: "bearer"; token: () => string | Promise<string> };
  /** Extra headers on every request (tests use this to carry a session cookie). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /**
   * Called on every 401/403 before the error is thrown (logout hooks). The
   * second argument names the operation (null for raw/stream calls), so a
   * failed `login` can be told apart from an expired session.
   */
  onAuthError?: (error: KernelApiError, operation: KernelOperationKey | null) => void;
}

function buildPath(template: string, params: Record<string, string | number> | undefined) {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null) {
      throw new KernelApiError(
        `Missing path param "${name}" for ${template}`,
        "contract",
        null,
        "missing_path_param",
        null,
      );
    }
    return encodeURIComponent(String(value));
  });
}

function buildQuery(query: Record<string, unknown> | undefined) {
  if (!query) {
    return "";
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(key, String(item));
      }
      continue;
    }
    search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export async function executeKernelRequest(input: {
  def: KernelOperationDef;
  options: KernelClientOptions;
  params?: Record<string, string | number>;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  headers?: Record<string, string> | undefined;
}): Promise<Response> {
  const { def, options } = input;
  const fetchImpl = options.fetch ?? fetch;
  const url = `${options.baseUrl}${buildPath(def.path, input.params)}${buildQuery(input.query)}`;

  const headers: Record<string, string> = { ...options.headers, ...input.headers };
  if (options.auth?.mode === "bearer") {
    headers.authorization = `Bearer ${await options.auth.token()}`;
  }
  const requestInit: RequestInit = {
    method: def.method,
    headers,
    ...(options.auth?.mode === "cookie" ? { credentials: "include" as const } : {}),
  };
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
    requestInit.body = JSON.stringify(input.body);
  }

  try {
    return await fetchImpl(url, requestInit);
  } catch (error) {
    throw new KernelApiError(
      `Network error calling ${def.method} ${def.path}: ${error instanceof Error ? error.message : "unknown"}`,
      "network",
      null,
      "network_error",
      null,
    );
  }
}

async function throwForErrorResponse(
  def: KernelOperationDef,
  response: Response,
  options: KernelClientOptions,
  operation: KernelOperationKey | null,
): Promise<never> {
  let body: unknown = null;
  const text = await response.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const envelope = (body ?? {}) as { error?: unknown; message?: unknown };
  const error = new KernelApiError(
    typeof envelope.message === "string"
      ? envelope.message
      : `${def.method} ${def.path} failed with ${response.status}`,
    categoryForStatus(response.status),
    response.status,
    typeof envelope.error === "string" ? envelope.error : null,
    body,
  );
  if (error.category === "auth") {
    options.onAuthError?.(error, operation);
  }
  throw error;
}

export function createKernelClient(
  operations: Record<KernelOperationKey, KernelOperationDef>,
  options: KernelClientOptions,
): KernelClient {
  const excluded = new Set<string>(SDK_EXCLUDED_OPERATIONS);

  async function call(key: KernelOperationKey, input: {
    params?: Record<string, string | number>;
    query?: Record<string, unknown>;
    body?: unknown;
  }): Promise<unknown> {
    const def = operations[key];
    const response = await executeKernelRequest({ def, options, ...input });
    if (!response.ok) {
      await throwForErrorResponse(def, response, options, key);
    }

    const responseSchemas = (routeSchemas[key] as { response?: Record<number, z.ZodType> }).response;
    const schema = responseSchemas?.[response.status];
    if (!schema) {
      throw new KernelApiError(
        `${def.method} ${def.path} returned undeclared status ${response.status}`,
        "contract",
        response.status,
        "undeclared_status",
        null,
      );
    }
    const payload: unknown = await response.json();
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new KernelApiError(
        `${def.method} ${def.path} response failed contract validation: ${parsed.error.message}`,
        "contract",
        response.status,
        "response_validation_failed",
        payload,
      );
    }
    return parsed.data;
  }

  const client = {
    async raw(key: KernelOperationKey, input?: {
      params?: Record<string, string | number>;
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
    }) {
      return executeKernelRequest({ def: operations[key], options, ...input });
    },
  } as Record<string, unknown>;

  for (const key of Object.keys(operations) as KernelOperationKey[]) {
    if (excluded.has(key)) {
      continue;
    }
    client[key] = (input?: {
      params?: Record<string, string | number>;
      query?: Record<string, unknown>;
      body?: unknown;
    }) => call(key, input ?? {});
  }

  return client as unknown as KernelClient;
}

// --- Stream helpers (Stage 20 Task 2) ---

import {
  aiGatewayStreamFrameSchema,
  domainEventFrameSchema,
  domainEventsSnapshotRequiredResponseSchema,
  syncEventSchema,
  syncSnapshotRequiredResponseSchema,
  type AiGatewayStreamFrame,
  type DomainEventFrame,
  type DomainEventsSnapshotRequired,
  type SyncEvent,
} from "./routes.ts";
import type { z as zod } from "zod";

interface RawSseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<RawSseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame: RawSseFrame = { id: null, event: null, data: "" };
        for (const line of raw.split("\n")) {
          if (line.startsWith(":") || line.startsWith("retry:")) {
            continue; // heartbeat comments and reconnect hints
          }
          if (line.startsWith("id: ")) {
            frame.id = line.slice(4);
          } else if (line.startsWith("event: ")) {
            frame.event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            frame.data += (frame.data ? "\n" : "") + line.slice(6);
          }
        }
        if (frame.id !== null || frame.event !== null || frame.data !== "") {
          yield frame;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface KernelStreamHandle {
  /** Resolves when the stream ends (server bound, snapshot-required, or close()). */
  done: Promise<void>;
  close: () => void;
}

export type SyncSnapshotRequired = zod.infer<typeof syncSnapshotRequiredResponseSchema>;

async function openSseResponse(input: {
  options: KernelClientOptions;
  method: string;
  path: string;
  headers?: Record<string, string> | undefined;
  body?: unknown;
  signal: AbortSignal;
}): Promise<Response> {
  const { options } = input;
  const fetchImpl = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    ...options.headers,
    ...input.headers,
  };
  if (options.auth?.mode === "bearer") {
    headers.authorization = `Bearer ${await options.auth.token()}`;
  }
  const init: RequestInit = {
    method: input.method,
    headers,
    signal: input.signal,
    ...(options.auth?.mode === "cookie" ? { credentials: "include" as const } : {}),
  };
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(input.body);
  }
  try {
    return await fetchImpl(`${options.baseUrl}${input.path}`, init);
  } catch (error) {
    throw new KernelApiError(
      `Network error opening ${input.path}: ${error instanceof Error ? error.message : "unknown"}`,
      "network",
      null,
      "network_error",
      null,
    );
  }
}

/**
 * Subscribe to the v1 sync-event stream (`GET /api/v1/events/stream`).
 * Single connection, no auto-reconnect: the server bounds stream lifetime
 * (~15 min) and v1 clients own their reconnect loop, resuming via
 * `lastEventId`. A 409 becomes `onSnapshotRequired` and ends the stream.
 */
export function subscribeSyncEvents(options: KernelClientOptions, input: {
  lastEventId?: number | null;
  onFrame: (frame: { id: number; event: SyncEvent }) => void;
  onSnapshotRequired?: (details: SyncSnapshotRequired) => void;
  signal?: AbortSignal;
}): KernelStreamHandle {
  const abort = new AbortController();
  input.signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const done = (async () => {
    const response = await openSseResponse({
      options,
      method: "GET",
      path: "/api/v1/events/stream",
      headers: input.lastEventId != null ? { "last-event-id": String(input.lastEventId) } : undefined,
      signal: abort.signal,
    });
    if (response.status === 409) {
      const body: unknown = await response.json();
      const parsed = syncSnapshotRequiredResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new KernelApiError(
          "events/stream 409 body failed contract validation",
          "contract",
          409,
          "response_validation_failed",
          body,
        );
      }
      input.onSnapshotRequired?.(parsed.data);
      return;
    }
    if (!response.ok || !response.body) {
      throw new KernelApiError(
        `events/stream failed with ${response.status}`,
        response.status === 401 || response.status === 403 ? "auth" : "server",
        response.status,
        null,
        await response.text().catch(() => null),
      );
    }
    for await (const frame of parseSseStream(response.body)) {
      if (frame.event !== "sync" || frame.data === "") {
        continue; // retry hints / heartbeats
      }
      const parsed = syncEventSchema.safeParse(JSON.parse(frame.data));
      if (!parsed.success) {
        throw new KernelApiError(
          `sync frame failed contract validation: ${parsed.error.message}`,
          "contract",
          200,
          "frame_validation_failed",
          frame.data,
        );
      }
      input.onFrame({ id: Number(frame.id), event: parsed.data });
    }
  })().catch((error: unknown) => {
    if (abort.signal.aborted) {
      return; // close() is not an error
    }
    throw error;
  });

  return { done, close: () => abort.abort() };
}

/**
 * Stream one AI generation through the gateway
 * (`POST /api/v1/ai/gateway/stream`, `event: ai` frames).
 */
export function streamAiGateway(options: KernelClientOptions, input: {
  body: zod.input<(typeof routeSchemas)["aiGatewayStream"]["body"]>;
  onFrame: (frame: AiGatewayStreamFrame) => void;
  signal?: AbortSignal;
}): KernelStreamHandle {
  const abort = new AbortController();
  input.signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const done = (async () => {
    const response = await openSseResponse({
      options,
      method: "POST",
      path: "/api/v1/ai/gateway/stream",
      body: input.body,
      signal: abort.signal,
    });
    if (!response.ok || !response.body) {
      let body: unknown = null;
      const text = await response.text().catch(() => "");
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      const envelope = (body ?? {}) as { error?: unknown; message?: unknown };
      throw new KernelApiError(
        typeof envelope.message === "string" ? envelope.message : `ai/gateway/stream failed with ${response.status}`,
        response.status === 401 || response.status === 403 ? "auth" : response.status >= 500 ? "server" : "validation",
        response.status,
        typeof envelope.error === "string" ? envelope.error : null,
        body,
      );
    }
    for await (const frame of parseSseStream(response.body)) {
      if (frame.event !== "ai" || frame.data === "") {
        continue;
      }
      const parsed = aiGatewayStreamFrameSchema.safeParse(JSON.parse(frame.data));
      if (!parsed.success) {
        throw new KernelApiError(
          `ai frame failed contract validation: ${parsed.error.message}`,
          "contract",
          200,
          "frame_validation_failed",
          frame.data,
        );
      }
      input.onFrame(parsed.data);
    }
  })().catch((error: unknown) => {
    if (abort.signal.aborted) {
      return;
    }
    throw error;
  });

  return { done, close: () => abort.abort() };
}

/**
 * Thin passthrough for the wildcard read gateway (`GET /api/v1/ofapi/read/*`):
 * upstream shapes are proxied verbatim, so no validation — the caller gets the
 * raw Response.
 */
export async function ofapiRead(options: KernelClientOptions, input: {
  path: string;
  query?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
}): Promise<Response> {
  const cleanPath = input.path.replace(/^\/+/, "");
  return executeKernelRequest({
    def: { method: "GET", path: `/api/v1/ofapi/read/${cleanPath}` },
    options,
    query: input.query,
    headers: input.headers,
  });
}

/**
 * Subscribe to the v2 domain-event stream (`GET /api/v1/events/v2/stream`,
 * kernel Stage 21). The cursor is OPAQUE — persist the last delivered one and
 * hand it back on reconnect. Single connection, no auto-reconnect (same
 * contract as v1: the server bounds stream lifetime; consumers own the loop).
 * A 409 becomes `onSnapshotRequired` with the per-account detail; recover via
 * `client.eventsV2Snapshot(...)` and resubscribe with the fresh cursor.
 */
export function subscribeDomainEvents(options: KernelClientOptions, input: {
  cursor?: string | null;
  onFrame: (frame: { cursor: string; event: DomainEventFrame }) => void;
  onSnapshotRequired?: (details: DomainEventsSnapshotRequired) => void;
  signal?: AbortSignal;
}): KernelStreamHandle {
  const abort = new AbortController();
  input.signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const done = (async () => {
    const response = await openSseResponse({
      options,
      method: "GET",
      path: "/api/v1/events/v2/stream",
      headers: input.cursor ? { "last-event-id": input.cursor } : undefined,
      signal: abort.signal,
    });
    if (response.status === 409) {
      const body: unknown = await response.json();
      const parsed = domainEventsSnapshotRequiredResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new KernelApiError(
          "events/v2/stream 409 body failed contract validation",
          "contract",
          409,
          "response_validation_failed",
          body,
        );
      }
      input.onSnapshotRequired?.(parsed.data);
      return;
    }
    if (!response.ok || !response.body) {
      throw new KernelApiError(
        `events/v2/stream failed with ${response.status}`,
        response.status === 401 || response.status === 403 ? "auth" : "server",
        response.status,
        null,
        await response.text().catch(() => null),
      );
    }
    for await (const frame of parseSseStream(response.body)) {
      if (frame.event !== "domain" || frame.data === "" || frame.id === null) {
        continue;
      }
      const parsed = domainEventFrameSchema.safeParse(JSON.parse(frame.data));
      if (!parsed.success) {
        throw new KernelApiError(
          `domain frame failed contract validation: ${parsed.error.message}`,
          "contract",
          200,
          "frame_validation_failed",
          frame.data,
        );
      }
      input.onFrame({ cursor: frame.id, event: parsed.data });
    }
  })().catch((error: unknown) => {
    if (abort.signal.aborted) {
      return;
    }
    throw error;
  });

  return { done, close: () => abort.abort() };
}
