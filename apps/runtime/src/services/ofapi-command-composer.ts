import { ofapiSendV2PayloadSchema } from "@agency_hub_core/contracts";
import { millsFromCents, millsToDollarsNumber, type OfapiExtendedCommandKind, type OfapiExtendedCommandPayload } from "@agency_hub_core/shared";
export function ofapiWireId(id: string): string | number {
  const value = /^\d+$/.test(id) ? Number(id) : NaN;
  return Number.isSafeInteger(value) ? value : id;
}
export function buildOfapiSendV2Body(payload: unknown) {
  const p = ofapiSendV2PayloadSchema.parse(payload);
  return {
    text: p.text, price: millsToDollarsNumber(millsFromCents(p.priceCents)), lockedText: p.lockedText,
    mediaFiles: p.mediaFiles.map(ofapiWireId), previews: p.previews.map(ofapiWireId),
    ...(p.replyToMessageId ? { replyToMessageId: ofapiWireId(p.replyToMessageId) } : {}),
    ...(p.giphyId ? { giphyId: p.giphyId } : {}),
    ...(p.rfTag.length ? { rfTag: p.rfTag.map(ofapiWireId) } : {}),
    ...(p.rfPartner.length ? { rfPartner: p.rfPartner.map(ofapiWireId) } : {}),
    ...(p.rfGuest.length ? { rfGuest: p.rfGuest.map(ofapiWireId) } : {}),
    ...(p.blockBannedWords ? { blockBannedWords: p.blockBannedWords } : {}),
  };
}
/** Closed action map: untrusted input can never select an arbitrary vendor path or method. */
export function ofapiExtendedAction(kind: Exclude<OfapiExtendedCommandKind, "send_message_v2">, accountId: string, conversationId: string, payload: OfapiExtendedCommandPayload) {
  const root = `/${encodeURIComponent(accountId)}`;
  const chat = `${root}/chats/${encodeURIComponent(conversationId)}`;
  if (kind === "set_fan_custom_name_v1") return { method: "PUT", path: `${root}/fans/${encodeURIComponent(conversationId)}/custom-name`, body: { custom_name: (payload as { customName: string }).customName } };
  const suffix = { like_message_v1: ["POST", "like"], unlike_message_v1: ["DELETE", "unlike"], pin_message_v1: ["POST", "pin"], unpin_message_v1: ["DELETE", "unpin"] } as const;
  if (kind in suffix) {
    const [method, action] = suffix[kind as keyof typeof suffix];
    return { method, path: `${chat}/messages/${encodeURIComponent((payload as { messageId: string }).messageId)}/${action}`, body: undefined };
  }
  const chats = { mark_chat_unread_v1: ["POST", "mark-as-unread"], mute_chat_v1: ["POST", "mute"], unmute_chat_v1: ["DELETE", "unmute"], hide_chat_v1: ["POST", "hide"] } as const;
  const [method, action] = chats[kind as keyof typeof chats];
  return { method, path: `${chat}/${action}`, body: undefined };
}

/** Webhooks can confirm v2 only when they actually carry the requested composer evidence. */
export function ofapiSentWebhookMatchesV2(payload: unknown, observed: Record<string, unknown>): boolean {
  const parsed = ofapiSendV2PayloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  const p = parsed.data;
  const body = buildOfapiSendV2Body(p);
  if (observed.text !== p.text || observed.price !== body.price || observed.lockedText !== p.lockedText) return false;
  const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const reply = observed.replyToMessageId ?? object(observed.replyToMessage)?.id ?? null;
  if ((reply === null ? null : String(reply)) !== p.replyToMessageId || (observed.giphyId ?? null) !== p.giphyId) return false;
  if (!Array.isArray(observed.media)) return false;
  const ids = observed.media.map(item => object(item)?.id).map(id => typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id)) ? String(id) : null);
  if (p.mediaFiles.some(id => id.startsWith("ofapi_media_")) || ids.length !== p.mediaFiles.length || ids.some((id,index) => id !== p.mediaFiles[index])) return false;
  for (const field of ["rfTag", "rfPartner", "rfGuest"] as const) {
    const observedTags = observed[field];
    if (observedTags === undefined && p[field].length === 0) continue;
    if (!Array.isArray(observedTags) || JSON.stringify(observedTags.map(String)) !== JSON.stringify(p[field])) return false;
  }
  return true;
}
