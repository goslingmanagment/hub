import { FANSLY_WS_MAX_FRAME_BYTES, wsJson, wsObject } from "./fansly-ws-capture.ts";

/** Candidate wire types. Enabling each type still requires the live corpus;
 * knowing how to extract an address does not certify provider semantics. */
export const FANSLY_WS_HINT_TYPES = ["message_created", "group_created"] as const;
export type FanslyWsHintType = typeof FANSLY_WS_HINT_TYPES[number];
export type FanslyWsHint = {
  type: FanslyWsHintType;
  groupRef: string;
  messageRef: string | null;
  /** AI media describer accelerator: present only on a message_created
   * frame that carries attachments (ids only, never a URL). */
  hasAttachments?: true;
  senderRef?: string | null;
};
export type FanslyWsMutationDebt = {
  groupRef: string | null;
  messageRef: string;
  correlationRef: string | null;
  bulk: boolean | null;
};
export type FanslyWsHintNode = {
  path: number[];
  outcome: "hint" | "mutation_debt" | "not_enabled" | "unrouted" | "invalid" | "limit";
  hint?: FanslyWsHint;
  mutation?: FanslyWsMutationDebt;
};

const nativeRef = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9]{1,32}$/.test(value) ? value : null;

/** Address extraction from already durable B0 envelopes. No full message,
 * auth, arbitrary field, timestamp ordering or business write escapes here.
 * Delete remains mutation debt; a read of the current head cannot settle it. */
export function extractFanslyWsHints(frame: string, enabled: ReadonlySet<FanslyWsHintType>) {
  const nodes: FanslyWsHintNode[] = [];
  if (Buffer.byteLength(frame) > FANSLY_WS_MAX_FRAME_BYTES) {
    return [{ path: [], outcome: "limit" }] satisfies FanslyWsHintNode[];
  }
  function visit(encoded: unknown, path: number[]) {
    if (path.length > 8 || nodes.length >= 255) {
      nodes.push({ path, outcome: "limit" });
      return;
    }
    const wrapper = wsObject(encoded);
    if (!wrapper) { nodes.push({ path, outcome: "invalid" }); return; }
    if (wrapper.t === 10001) {
      const children = wsJson(wrapper.d);
      if (!Array.isArray(children)) { nodes.push({ path, outcome: "invalid" }); return; }
      // Count containers too, so empty/nested batches cannot bypass the bound.
      nodes.push({ path, outcome: "unrouted" });
      for (let i = 0; i < children.length; i++) {
        if (nodes.length >= 256) break;
        if (nodes.length >= 255) { nodes.push({ path: [...path, i], outcome: "limit" }); break; }
        visit(children[i], [...path, i]);
      }
      return;
    }
    // An alternate inner-service shape is research evidence, not an approved
    // account-socket route. Keep it visible without inferring source semantics.
    if (wrapper.t !== 10000) { nodes.push({ path, outcome: "unrouted" }); return; }
    const service = wsObject(wrapper.d);
    const event = wsObject(service?.event);
    if (!service || !event) { nodes.push({ path, outcome: "invalid" }); return; }
    if (service.serviceId === 5 && event.type === 10) {
      const message = wsObject(event.message);
      const messageRef = nativeRef(message?.id);
      if (!messageRef) { nodes.push({ path, outcome: "invalid" }); return; }
      nodes.push({ path, outcome: "mutation_debt", mutation: {
        messageRef, groupRef: nativeRef(message?.groupId),
        correlationRef: nativeRef(message?.correlationId),
        bulk: typeof message?.type === "number" ? message.type === 3 : null,
      } });
      return;
    }
    let hint: FanslyWsHint | null = null;
    if (service.serviceId === 5 && event.type === 1) {
      const message = wsObject(event.message);
      const groupRef = nativeRef(message?.groupId);
      const messageRef = nativeRef(message?.id);
      if (!groupRef || !messageRef) { nodes.push({ path, outcome: "invalid" }); return; }
      const attachmentCount = Array.isArray(message?.attachments) ? message.attachments.length : 0;
      hint = attachmentCount > 0
        ? { type: "message_created", groupRef, messageRef, hasAttachments: true, senderRef: nativeRef(message?.senderId) }
        : { type: "message_created", groupRef, messageRef };
    } else if (service.serviceId === 4 && event.type === 8) {
      const groupRef = nativeRef(event.id);
      if (!groupRef) { nodes.push({ path, outcome: "invalid" }); return; }
      hint = { type: "group_created", groupRef, messageRef: null };
    }
    if (!hint) { nodes.push({ path, outcome: "unrouted" }); return; }
    nodes.push(enabled.has(hint.type) ? { path, outcome: "hint", hint }
      : { path, outcome: "not_enabled" });
  }
  visit(frame, []);
  return nodes;
}
