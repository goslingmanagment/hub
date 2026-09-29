import { FANSLY_WS_MAX_FRAME_BYTES, wsJson, wsObject } from "./fansly-ws-capture.ts";

/** A fan message with media, read from an already durable B0 frame. Ids and
 * the message instant only — never a URL, text or any other field. */
export type FanslyWsFanMediaMessage = {
  groupRef: string;
  messageRef: string;
  senderRef: string;
  /** Epoch ms of the message, when the frame carried a sane one. */
  createdAtMs: number | null;
  attachments: Array<{ contentType: number; contentRef: string }>;
};

/** Attachment content types that can carry an image: a media offer or a
 * bundle. Tips (7) and the rest never trigger a read. */
export const FANSLY_WS_MEDIA_CONTENT_TYPES: ReadonlySet<number> = new Set([1, 2]);

const nativeRef = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9]{1,32}$/.test(value) ? value : null;

function instantMs(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^[0-9]{9,14}$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  // Fansly stamps seconds in some envelopes and milliseconds in others.
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

/**
 * The AI media fast lane's signal (docs/runbooks/ai-media-describe.md):
 * `message_created` events whose sender is not the page and whose
 * attachments include a media offer or a bundle. Same envelope walk and
 * bounds as the B1 hint extractor; it reads nothing else.
 */
export function extractFanslyWsFanMediaMessages(frame: string, ownRef: string): FanslyWsFanMediaMessage[] {
  const found: FanslyWsFanMediaMessage[] = [];
  if (Buffer.byteLength(frame) > FANSLY_WS_MAX_FRAME_BYTES) return found;
  let visited = 0;
  function visit(encoded: unknown, depth: number) {
    if (depth > 8 || visited >= 255) return;
    visited += 1;
    const wrapper = wsObject(encoded);
    if (!wrapper) return;
    if (wrapper.t === 10001) {
      const children = wsJson(wrapper.d);
      if (!Array.isArray(children)) return;
      for (const child of children) {
        if (visited >= 255) break;
        visit(child, depth + 1);
      }
      return;
    }
    if (wrapper.t !== 10000) return;
    const service = wsObject(wrapper.d);
    const event = wsObject(service?.event);
    if (!service || !event || service.serviceId !== 5 || event.type !== 1) return;
    const message = wsObject(event.message);
    const groupRef = nativeRef(message?.groupId);
    const messageRef = nativeRef(message?.id);
    const senderRef = nativeRef(message?.senderId);
    if (!groupRef || !messageRef || !senderRef || senderRef === ownRef) return;
    const attachments: FanslyWsFanMediaMessage["attachments"] = [];
    for (const raw of Array.isArray(message?.attachments) ? message.attachments : []) {
      const attachment = wsObject(raw);
      const contentType = typeof attachment?.contentType === "number" ? attachment.contentType : NaN;
      const contentRef = nativeRef(attachment?.contentId);
      if (contentRef && FANSLY_WS_MEDIA_CONTENT_TYPES.has(contentType)) {
        attachments.push({ contentType, contentRef });
      }
    }
    if (attachments.length === 0) return;
    found.push({ groupRef, messageRef, senderRef, createdAtMs: instantMs(message?.createdAt), attachments });
  }
  visit(frame, 0);
  return found;
}
