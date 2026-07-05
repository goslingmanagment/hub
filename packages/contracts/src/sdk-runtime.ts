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
  /** Called on every 401/403 before the error is thrown (logout hooks). */
  onAuthError?: (error: KernelApiError) => void;
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
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
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
    options.onAuthError?.(error);
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
      await throwForErrorResponse(def, response, options);
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
