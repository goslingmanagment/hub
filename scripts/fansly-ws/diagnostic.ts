import { code, decodeJson, record, summarizeEvent } from "./diagnostic-fields.ts";

export const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_NODES = 256;
const MAX_DEPTH = 8;

type NodeKind = "error" | "session_verified_frame" | "pong" | "batch" | "service"
  | "candidate_inner_service" | "unknown";
type DiagnosticNode = {
  path: number[];
  kind: NodeKind;
  transportType: number | null;
  serviceId?: number | null;
  eventType?: number | null;
  errorCode?: number | null;
  reason?: "invalid_wrapper" | "invalid_payload" | "unknown_transport" | "depth_limit";
  event?: ReturnType<typeof summarizeEvent>;
};

/** Offline metadata only. A t=1 frame is not a verified account binding.
 * This is not the durable capture representation or a business-event parser. */
export function diagnoseFrame(frame: string, key: Buffer) {
  if (key.length !== 32) throw new Error("diagnostic_key_length");
  const bytes = Buffer.byteLength(frame);
  const nodes: DiagnosticNode[] = [];
  let truncated = false;

  function visit(encoded: unknown, path: number[]) {
    if (nodes.length >= MAX_NODES) { truncated = true; return; }
    const wrapper = record(decodeJson(encoded));
    const transportType = code(wrapper?.t);
    const node: DiagnosticNode = { path, kind: "unknown", transportType };
    nodes.push(node);
    if (path.length > MAX_DEPTH) {
      truncated = true;
      node.reason = "depth_limit";
      return;
    }
    if (!wrapper) { node.reason = "invalid_wrapper"; return; }

    const inner = !Object.hasOwn(wrapper, "t") && Object.hasOwn(wrapper, "serviceId");
    if (inner || transportType === 10000) {
      const service = inner ? wrapper : record(decodeJson(wrapper.d));
      const event = record(decodeJson(service?.event));
      node.kind = inner ? "candidate_inner_service" : "service";
      node.serviceId = code(service?.serviceId);
      node.eventType = code(event?.type);
      if (!event || node.serviceId === null || node.eventType === null) {
        node.reason = "invalid_payload";
      }
      if (event) node.event = summarizeEvent(event, key);
      return;
    }
    if (transportType === 10001) {
      node.kind = "batch";
      const children = decodeJson(wrapper.d);
      if (!Array.isArray(children)) { node.reason = "invalid_payload"; return; }
      for (let index = 0; index < children.length; index++) {
        if (nodes.length >= MAX_NODES) { truncated = true; break; }
        visit(children[index], [...path, index]);
      }
      return;
    }
    const payload = record(decodeJson(wrapper.d));
    switch (transportType) {
      case 0:
        node.kind = "error";
        node.errorCode = code(payload?.code);
        if (node.errorCode === null) node.reason = "invalid_payload";
        break;
      case 1:
        node.kind = "session_verified_frame";
        if (!payload) node.reason = "invalid_payload";
        break;
      case 2:
        node.kind = "pong";
        if (!payload) node.reason = "invalid_payload";
        break;
      default:
        node.reason = transportType === null ? "invalid_wrapper" : "unknown_transport";
    }
  }

  if (bytes > MAX_FRAME_BYTES) {
    return { bytes, nodes, truncated: true, rejected: "frame_too_large" as const };
  }
  visit(frame, []);
  return { bytes, nodes, truncated, rejected: null };
}

/** Deny outbound/ambiguous sources before looking at their frame body. URL,
 * headers and arbitrary metadata are never copied into the report. */
export function diagnoseReceivedRecord(input: unknown, key: Buffer) {
  const item = record(input);
  if (item?.direction !== "received") return { excluded: "not_received" as const };
  if (item.url !== "wss://wsv3.fansly.com/?v=3" && item.url !== "wss://wsv3.fansly.com?v=3") {
    return { excluded: "unapproved_endpoint" as const };
  }
  if (typeof item.frame !== "string" || typeof item.receivedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.receivedAt)) {
    return { excluded: "invalid_record" as const };
  }
  const date = new Date(item.receivedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== item.receivedAt) {
    return { excluded: "invalid_record" as const };
  }
  return { receivedAt: item.receivedAt, diagnostic: diagnoseFrame(item.frame, key) };
}
