/**
 * The board in the extension's frame (`/workboard/frame/report`, R-protocol.md): no credential ever enters the frame.
 * The frame says hello to its parent, accepts ONE `MessagePort` from it (the content script of fansly.com or
 * chat.onlymonster.ai), and from then on every API request of the board goes over that port as a `fetch` message; the
 * extension's background performs it with the device token and answers `fetch:result`. No React here.
 */

export const FRAME_PROTOCOL_VERSION = 1;
/** The sites the extension draws the frame on (production). A dev build also takes the stand's local origins. */
export const FRAME_PARENT_ORIGINS: readonly string[] = ["https://fansly.com", "https://chat.onlymonster.ai"];

/** The hosts a dev build's stand and the demo serve from: 127.0.0.1, localhost and `*.localhost`. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** What crosses the port, frame → extension (R-protocol.md «Messages over the port»). */
export type FrameMessage =
  | { t: "fetch"; id: number; method: string; path: string; body: string | null }
  | { t: "state"; shiftId: number | null; phase: "draft" | "checking" | "confirm" | "counted" | "fixing" | "none"; chip: string; count: number; totalMills: number; needsMe: boolean }
  | { t: "collapse" }
  | { t: "find"; sale: FindSale }
  | { t: "copy"; text: string }
  | { t: "statement"; pages: string[] };

export interface FindSale {
  transactionId: number | null;
  pageLabel: string;
  platform: string;
  platformRef: string | null;
  kind: string;
  occurredAt: string;
  netMills: number;
  grossMills: number | null;
  fanName: string | null;
  fanHandle: string | null;
}

/** Extension → frame. */
export type ExtensionMessage =
  | { t: "fetch:result"; id: number; status?: number; body?: string; error?: "refused" | "network" | "signed_out" }
  | { t: "show"; transactionId?: number | null }
  | { t: "copy:result"; ok: boolean }
  | { t: "found"; transactionId: number | null; ok: boolean; words?: string };

/** The part of a `MessagePort` the transport uses (a fake one in tests). */
export interface PortLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

export interface PortTransport {
  /** A `fetch` for the API client: same-origin API paths only, answered over the port. */
  fetch: typeof fetch;
  post(message: Exclude<FrameMessage, { t: "fetch" }>): void;
  /** Listen to the extension's messages other than `fetch:result`; returns the way to stop. */
  on(listener: (message: ExtensionMessage) => void): () => void;
  /** «Скопировать пост» through the extension: the frame itself may be refused the clipboard. */
  copy(text: string): Promise<boolean>;
  close(): void;
}

/** The extension did not answer a request in this long: the board says Hub did not answer. */
export const PORT_FETCH_TIMEOUT_MS = 30_000;
const COPY_TIMEOUT_MS = 5_000;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** An API path of the board's request with its query: only the path crosses, the extension adds Hub's origin. */
function pathOf(input: RequestInfo | URL): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, "https://frame.invalid");
  return `${url.pathname}${url.search}`;
}

/**
 * The board's requests over the port. Each request has its own id and waits for the `fetch:result` with that id, in
 * whatever order answers come. `refused` (not on the extension's allow-list) reads as Hub's 403, `signed_out` (no
 * device token) as a 401; `network`, a timeout or a closed transport reject like a failed fetch.
 */
export function portTransport(port: PortLike, options: { timeoutMs?: number } = {}): PortTransport {
  const timeoutMs = options.timeoutMs ?? PORT_FETCH_TIMEOUT_MS;
  let nextId = 1;
  let closed = false;
  const waiting = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(message: ExtensionMessage) => void>();

  const onMessage = (event: { data: unknown }) => {
    const message = event.data as ExtensionMessage | null;
    if (message === null || typeof message !== "object" || typeof (message as { t?: unknown }).t !== "string") return;
    if (message.t === "fetch:result") {
      const one = waiting.get(message.id);
      if (one === undefined) return;
      waiting.delete(message.id);
      clearTimeout(one.timer);
      if (message.error === "refused") {
        one.resolve(new Response(JSON.stringify({ error: "refused", message: "The extension does not pass this request", statusCode: 403 }), { status: 403, headers: JSON_HEADERS }));
      } else if (message.error === "signed_out") {
        one.resolve(new Response(JSON.stringify({ error: "signed_out", message: "ChatGoose is signed out", statusCode: 401 }), { status: 401, headers: JSON_HEADERS }));
      } else if (message.error !== undefined || typeof message.status !== "number") {
        one.reject(new TypeError("The extension could not reach Hub"));
      } else {
        const empty = message.status === 204 || message.status === 304;
        one.resolve(new Response(empty ? null : message.body ?? "", { status: message.status, headers: JSON_HEADERS }));
      }
      return;
    }
    for (const listener of listeners) listener(message);
  };
  port.addEventListener("message", onMessage);
  port.start?.();

  const fetchOverPort = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (closed) return Promise.reject(new TypeError("The board's channel is closed"));
    const path = pathOf(input);
    if (!path.startsWith("/api/v1/")) return Promise.reject(new TypeError(`Not an API path: ${path}`));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    const id = nextId++;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new TypeError("The extension did not answer"));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      port.postMessage({ t: "fetch", id, method, path, body } satisfies FrameMessage);
    });
  };

  return {
    fetch: fetchOverPort as typeof fetch,
    post: (message) => {
      if (!closed) port.postMessage(message);
    },
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    copy: (text) => new Promise<boolean>((resolve) => {
      if (closed) {
        resolve(false);
        return;
      }
      let stop = () => {};
      const timer = setTimeout(() => {
        stop();
        resolve(false);
      }, COPY_TIMEOUT_MS);
      const listener = (message: ExtensionMessage) => {
        if (message.t !== "copy:result") return;
        clearTimeout(timer);
        stop();
        resolve(message.ok);
      };
      listeners.add(listener);
      stop = () => listeners.delete(listener);
      port.postMessage({ t: "copy", text } satisfies FrameMessage);
    }),
    close: () => {
      closed = true;
      port.removeEventListener("message", onMessage);
      for (const [id, one] of waiting) {
        clearTimeout(one.timer);
        one.reject(new TypeError("The board's channel is closed"));
        waiting.delete(id);
      }
      listeners.clear();
      port.close?.();
    },
  };
}

/** The part of `window` the handshake uses (a fake one in tests). */
export interface FrameWindowLike {
  parent: unknown;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}
export interface ParentLike {
  postMessage(message: unknown, targetOrigin: string): void;
}

export const HELLO_EVERY_MS = 500;
export const HELLO_TIMES = 20;
/** No port in this long: «Откройте отчёт из ChatGoose». */
export const PORT_WAIT_MS = 10_000;

/**
 * Handshake version 1: say `report-board/hello` to the parent every 500 ms (at most 20 times) and take the first
 * `report-board/port` whose source is the parent and whose origin is allowed; later ones are ignored. Null — not in a
 * frame, or no port within 10 s.
 */
export function acceptPort(win: FrameWindowLike, allowed: (origin: string) => boolean, timing: { everyMs?: number; times?: number; waitMs?: number } = {}): Promise<MessagePort | null> {
  const parent = win.parent as ParentLike | null;
  if (parent === null || parent === undefined || parent === (win as unknown)) return Promise.resolve(null);
  const everyMs = timing.everyMs ?? HELLO_EVERY_MS;
  const times = timing.times ?? HELLO_TIMES;
  const waitMs = timing.waitMs ?? PORT_WAIT_MS;
  return new Promise((resolve) => {
    let said = 0;
    let done = false;
    const finish = (port: MessagePort | null) => {
      if (done) return;
      done = true;
      clearInterval(hello);
      clearTimeout(giveUp);
      win.removeEventListener("message", onMessage);
      resolve(port);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { cg?: unknown; v?: unknown } | null;
      if (event.source !== parent || data === null || typeof data !== "object") return;
      if (data.cg !== "report-board/port" || data.v !== FRAME_PROTOCOL_VERSION) return;
      if (!allowed(event.origin)) return;
      const port = event.ports?.[0];
      if (port === undefined) return;
      finish(port);
    };
    const say = () => {
      if (said >= times) {
        clearInterval(hello);
        return;
      }
      said += 1;
      try {
        parent.postMessage({ cg: "report-board/hello", v: FRAME_PROTOCOL_VERSION }, "*");
      } catch {
        // A parent that cannot be reached answers nothing: the wait runs out.
      }
    };
    win.addEventListener("message", onMessage);
    const hello = setInterval(say, everyMs);
    const giveUp = setTimeout(() => finish(null), waitMs);
    say();
  });
}
