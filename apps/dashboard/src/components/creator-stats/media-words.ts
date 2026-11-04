import { formatDay } from "@/lib/format";

import { formatWatchTime } from "./creator-stats-model.js";

/** What a media row carries for its name and its second line. */
export interface MediaHead {
  mediaType: number | null;
  durationMs: number | null;
  caption: string | null;
  postedAt: string | null;
  deletedAt: string | null;
}

const CAPTION_LIMIT = 70;

/** The post's text up to 70 signs; without one, the kind: «Видео без подписи». The number never. */
export function mediaTitle(head: Pick<MediaHead, "mediaType" | "caption">): string {
  const caption = head.caption?.replace(/\s+/g, " ").trim();
  if (caption) return caption.length > CAPTION_LIMIT ? `${caption.slice(0, CAPTION_LIMIT).trimEnd()}…` : caption;
  return head.mediaType === 2 ? "Видео без подписи" : head.mediaType === 1 ? "Фото без подписи" : "Медиа без подписи";
}

/** «видео · 3 мин» */
export function mediaKind(head: Pick<MediaHead, "mediaType" | "durationMs">): string {
  if (head.mediaType === 2) return head.durationMs ? `видео · ${formatWatchTime(head.durationMs)}` : "видео";
  if (head.mediaType === 1) return "фото";
  return "медиа";
}

/** «видео · 3 мин · 18 окт. · удалено 3 окт.»; `posted` names the date «вышло 18 окт.». */
export function mediaLine(head: MediaHead, options: { posted?: boolean } = {}): string {
  const parts = [mediaKind(head)];
  if (head.postedAt) parts.push(options.posted ? `вышло ${formatDay(head.postedAt)}` : formatDay(head.postedAt));
  if (head.deletedAt) parts.push(`удалено ${formatDay(head.deletedAt)}`);
  return parts.join(" · ");
}

export function fanslyPostUrl(postId: string): string {
  return `https://fansly.com/post/${encodeURIComponent(postId)}`;
}
