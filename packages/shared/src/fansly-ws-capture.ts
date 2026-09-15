/** B0's storage codec. The exact received text survives; business decoding is
 * deliberately separate and is only called after the journal commit. */
export const FANSLY_WS_CAPTURE_KIND = "fansly.ws.frame.v1";
export const FANSLY_WS_MAX_FRAME_BYTES = 1024 * 1024;

export function wsJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

export function wsObject(value: unknown): Record<string, unknown> | null {
  const decoded = wsJson(value);
  return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
    ? decoded as Record<string, unknown> : null;
}

/** Transport classification only. Never return session/error bodies to storage
 * or logs. A verified-shaped frame does not establish account binding. */
export function classifyFanslyWsFrame(frame: string) {
  const outer = wsObject(frame);
  if (!outer) return "invalid" as const;
  if (outer.t === 0) {
    return wsObject(outer.d)?.code === 401 ? "auth_refused" as const : "provider_error" as const;
  }
  if (outer.t === 1) return wsObject(outer.d) ? "session" as const : "invalid" as const;
  if (outer.t === 2) return "pong" as const;
  return "business" as const;
}

export type FanslyWsDecodeNode = {
  path: number[];
  transportType: number | null;
  serviceId: number | null;
  eventType: number | null;
  state: "retained" | "unknown" | "invalid" | "limit" | "control_excluded";
};

/** Exclude known transport controls inside batches too. Unchanged business
 * children keep their original encoded value; unknown children are retained. */
export function businessFanslyWsFrame(frame: string): string {
  let visited = 0;
  function strip(encoded: unknown, depth: number): { value: unknown; changed: boolean } {
    if (++visited > 4096 || depth > 32) throw new Error("fansly_ws_control_scan_limit");
    const wrapper = wsObject(encoded);
    if (!wrapper) return { value: encoded, changed: false };
    if (wrapper.t === 0 || wrapper.t === 1 || wrapper.t === 2) {
      return { value: { t: wrapper.t, excluded: true }, changed: true };
    }
    if (wrapper.t !== 10001) return { value: encoded, changed: false };
    const children = wsJson(wrapper.d);
    if (!Array.isArray(children)) return { value: encoded, changed: false };
    const results = children.map((child) => strip(child, depth + 1));
    if (!results.some((r) => r.changed)) return { value: encoded, changed: false };
    const clean = { ...wrapper, d: typeof wrapper.d === "string"
      ? JSON.stringify(results.map((r) => r.value)) : results.map((r) => r.value) };
    return { value: typeof encoded === "string" ? JSON.stringify(clean) : clean, changed: true };
  }
  return strip(frame, 0).value as string;
}

/** Metadata receipts, never business apply. Unknown children remain in raw,
 * including everything past the bounded decoder's traversal limit. */
export function decodeFanslyWsCapture(frame: string): FanslyWsDecodeNode[] {
  const nodes: FanslyWsDecodeNode[] = [];
  const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) ? v : null;
  function visit(value: unknown, path: number[]) {
    const wrapper = wsObject(value);
    const node: FanslyWsDecodeNode = {
      path, transportType: number(wrapper?.t), serviceId: null, eventType: null, state: "unknown",
    };
    nodes.push(node);
    if (path.length > 8 || nodes.length >= 256) { node.state = "limit"; return; }
    if (!wrapper) { node.state = "invalid"; return; }
    if (wrapper.t === 10001) {
      const children = wsJson(wrapper.d);
      if (!Array.isArray(children)) { node.state = "invalid"; return; }
      node.state = "retained";
      for (let i = 0; i < children.length; i++) {
        if (nodes.length >= 255) {
          nodes.push({ ...node, path: [...path, i], state: "limit" });
          break;
        }
        visit(children[i], [...path, i]);
      }
    } else if (wrapper.t === 10000 || (!Object.hasOwn(wrapper, "t") && Object.hasOwn(wrapper, "serviceId"))) {
      const service = wrapper.t === 10000 ? wsObject(wrapper.d) : wrapper;
      node.serviceId = number(service?.serviceId);
      node.eventType = number(wsObject(service?.event)?.type);
      // No event type is approved for routing in B0. A well-formed service
      // envelope is retained, never advertised as applied or understood.
      node.state = node.serviceId !== null && node.eventType !== null ? "retained" : "invalid";
    } else if (wrapper.t === 0 || wrapper.t === 1 || wrapper.t === 2) {
      node.state = "control_excluded";
    }
  }
  visit(frame, []);
  return nodes;
}

/** Erasure-only search through encoded JSON (also used on tiered lake rows).
 * Ambiguous/deep data is matched conservatively rather than certifying absence. */
export function fanslyWsCaptureContainsSubject(payload: unknown, ref: string): boolean {
  const envelope = wsObject(payload);
  if (envelope?.codec !== FANSLY_WS_CAPTURE_KIND) return false;
  function contains(value: unknown, depth: number): boolean {
    if (depth > 32) return true;
    if (typeof value === "string") {
      if (value.includes(ref)) return true;
      const decoded = wsJson(value);
      return decoded !== null && decoded !== value && contains(decoded, depth + 1);
    }
    if (typeof value === "number") return String(value) === ref;
    if (Array.isArray(value)) return value.some((v) => contains(v, depth + 1));
    if (value && typeof value === "object") return Object.values(value).some((v) => contains(v, depth + 1));
    return false;
  }
  return contains(envelope.frame, 0);
}
