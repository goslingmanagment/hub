export const OFAPI_EXTENDED_COMMAND_KINDS = [
  "send_message_v2", "set_fan_custom_name_v1", "like_message_v1", "unlike_message_v1",
  "pin_message_v1", "unpin_message_v1", "mark_chat_unread_v1", "mute_chat_v1", "unmute_chat_v1", "hide_chat_v1",
] as const;
export type OfapiExtendedCommandKind = typeof OFAPI_EXTENDED_COMMAND_KINDS[number];
export type OfapiBannedWordsLevel = "strict_ban" | "risky" | "replace_soften";
export interface OfapiSendV2Payload {
  text: string; priceCents: number; mediaFiles: string[]; previews: string[]; lockedText: boolean;
  replyToMessageId: string | null; giphyId: string | null;
  rfTag: string[]; rfPartner: string[]; rfGuest: string[];
  blockBannedWords: OfapiBannedWordsLevel | null; reuseProviderOperation: boolean;
}
export type OfapiExtendedCommandPayload = OfapiSendV2Payload | { customName: string } | { messageId: string } | Record<string, never>;
