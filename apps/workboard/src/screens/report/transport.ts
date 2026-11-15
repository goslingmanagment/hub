/**
 * The board in the extension's frame (`/workboard/frame/report`, R-protocol.md): no credential ever enters the frame.
 * The extension puts a key into the frame's address; the frame accepts ONE `MessagePort` from its parent with that key
 * (handshake version 2), and from then on every API request of the board goes over that port as a `fetch` message; the
 * extension's background performs it with the device token and answers `fetch:result`. No React here.
 */

export const FRAME_PROTOCOL_VERSION = 2;
/** What crosses the port, frame → extension (R-protocol.md «Messages over the port»). */
export type FrameMessage =
  | { t: "fetch"; id: number; method: string; path: string; body: string | null }
  | { t: "state"; shiftId: number | null; phase: "draft" | "checking" | "confirm" | "counted" | "fixing" | "none"; chip: string; count: number; totalMills: number; needsMe: boolean }
  | { t: "collapse" }
  | { t: "find"; sale: FindSale }
  | { t: "copy"; text: string }
  | { t: "statement"; pages: string[] }
  /** «Обновите ChatGoose»: the board in a tab by the extension's one-time link (not in R-protocol.md yet: an extension that does not know it ignores it). */
  | { t: "open-tab" }
  /** Package R5: a frame screen finished — the order recorded (its code), the question asked — the fan panel reads it again. */
  | { t: "done"; screen: "custom" | "ask"; code?: string }
  | { t: "ready"; v: number };

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
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/** No port in this long: «Откройте отчёт из ChatGoose». */
export const PORT_WAIT_MS = 10_000;

/**
 * The frame's own address carries the key and the version: `#k=<key>&v=2`. Read once, then the hash is removed from
 * the address (a reload or a copied address never holds it). Null — no key.
 */
export function takeFrameKey(win: Pick<FrameWindowLike, "location" | "history">): { key: string; v: number } | null {
  const hash = win.location.hash.replace(/^#/, "");
  if (hash === "") return null;
  const params = new URLSearchParams(hash);
  win.history.replaceState(null, "", `${win.location.pathname}${win.location.search}`);
  const key = params.get("k");
  if (key === null || !/^[0-9a-f]{16,128}$/i.test(key)) return null;
  const v = Number(params.get("v") ?? FRAME_PROTOCOL_VERSION);
  return { key, v: Number.isInteger(v) ? v : -1 };
}

export type Handshake =
  | { kind: "port"; port: MessagePort }
  /** The extension speaks a version this frame does not know: «Обновите ChatGoose». Its port, if it sent one. */
  | { kind: "version"; port: MessagePort | null }
  /** Not in a frame, no key, or no port in 10 s: «Откройте отчёт из ChatGoose». */
  | { kind: "none" };

/**
 * Handshake version 2 (R-protocol.md): the frame broadcasts nothing. It takes the first `report-board/port` whose
 * source is its parent and whose `key` is the key of its own address, answers `{ t: "ready", v: 2 }` on that port,
 * and ignores everything else. A message with the right key and another version means the extension is of another
 * version.
 */
export function acceptPort(win: FrameWindowLike, frameKey: { key: string; v: number } | null, waitMs = PORT_WAIT_MS): Promise<Handshake> {
  const parent = win.parent;
  if (parent === null || parent === undefined || parent === (win as unknown) || frameKey === null) return Promise.resolve({ kind: "none" });
  if (frameKey.v !== FRAME_PROTOCOL_VERSION) return Promise.resolve({ kind: "version", port: null });
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: Handshake) => {
      if (done) return;
      done = true;
      clearTimeout(giveUp);
      win.removeEventListener("message", onMessage);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { cg?: unknown; v?: unknown; key?: unknown } | null;
      if (event.source !== parent || data === null || typeof data !== "object") return;
      if (data.cg !== "report-board/port" || data.key !== frameKey.key) return;
      const port = event.ports?.[0] ?? null;
      if (data.v !== FRAME_PROTOCOL_VERSION) {
        finish({ kind: "version", port });
        return;
      }
      if (port === null) return;
      port.postMessage({ t: "ready", v: FRAME_PROTOCOL_VERSION });
      finish({ kind: "port", port });
    };
    win.addEventListener("message", onMessage);
    const giveUp = setTimeout(() => finish({ kind: "none" }), waitMs);
  });
}
