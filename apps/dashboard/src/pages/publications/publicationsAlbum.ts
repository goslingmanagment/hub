import type { PublicationAlbumRun } from "@agency_hub_core/contracts";
import { millsFromCreditsAt, millsToDecimalString } from "@agency_hub_core/shared";
import { ruPlural } from "@/lib/plural";

// A vault album on the screen (Fansly 0323, OnlyFans 8-docs
// 2026-11-12-of-vault-album): its reason in words for both platforms, its
// price and its run. Hub writes an album's reason as `;`-joined parts
// (publications-vault-album-reason.ts and the two executors); each part reads
// as one short line, the files it names go in a hint.

const files = (value: number) => `${value} ${ruPlural(value, "файл", "файла", "файлов")}`;

/** Why an album waits or was not sent: the executor's admission and steps. */
const HOLD_WORDS: Readonly<Record<string, string>> = {
  publishing_off: "публикация выключена",
  vault_albums_off: "альбомы OnlyFans выключены",
  page_publishing_off: "публикация страницы выключена",
  key_scope_no_vault: "ключ OnlyFans API не пускает в медиатеку",
  vault_credits_paused: "потолок альбомов 0 — пауза",
  vault_credits_day_left: "не хватает дневного потолка",
  balance_low: "мало кредитов на балансе",
  balance_unknown: "баланс кредитов неизвестен",
  page_busy_with_album: "на странице идёт другой альбом",
  album_title_ambiguous: "у страницы несколько альбомов с этим названием",
  lists_not_read: "Hub не прочитал альбомы страницы",
  album_not_read: "Hub не прочитал альбом",
  album_contents_not_read: "Hub не прочитал, что уже в альбоме",
  album_create_not_sent: "создание альбома не ушло",
  album_create: "создание альбома не ушло",
  album_media: "добавление в альбом не ушло",
  album_media_unknown: "добавление в альбом не ушло",
  window_passed: "за 12 часов не начал",
  not_approved: "альбом больше не утверждён",
  approval_form_unreadable: "утверждённую версию не удалось прочитать",
};

/** Why the uploads stopped. */
const STOP_WORDS: Readonly<Record<string, string>> = {
  three_failures: "три сбоя подряд",
  price_exceeded: "трата превысила цену на 10 %",
  authorization_refused: "OnlyFans API отказал в доступе",
  stopped: "загрузки остановлены",
};

export function stopWord(code: string | null): string {
  return code === null ? STOP_WORDS.stopped! : STOP_WORDS[code] ?? STOP_WORDS.stopped!;
}

function holdWord(code: string): string | null {
  const head = code.split(":")[0] ?? code;
  return HOLD_WORDS[head] ?? null;
}

export interface AlbumReasonPart {
  text: string;
  /** The files it names, by name (a hint). */
  names: string[];
}

const names = (list: string | undefined) => (list === undefined || list === "" ? [] : list.split(",").map((entry) => entry.split("=")[0] ?? entry));

/** A step's reason that says the answer was lost or differed (the album is `unknown`): never «не создан», «не добавились». */
const NOT_CONFIRMED = /_found$|unknown|no_answer|answer_|attempt_missing|request_unreadable/;

/** One part of an album's reason, or null when it is not an album's. */
function albumPart(part: string): AlbumReasonPart | null {
  const [head = "", ...rest] = part.split(":");
  const tail = rest.join(":");
  const ratio = (value: string | undefined) => {
    const [n = "0", m = "0"] = (value ?? "").split("/");
    return `${n} из ${m}`;
  };
  switch (head) {
    case "files_failed": return { text: `Отказ: ${ratio(rest[0])}`, names: names(rest.slice(1).join(":")) };
    case "files_unknown": return { text: `Исход неизвестен: ${ratio(rest[0])}`, names: names(rest.slice(1).join(":")) };
    case "files_too_big": return { text: `Слишком большие: ${rest[0] ?? "?"} — добавить руками`, names: names(rest.slice(1).join(":")) };
    case "files_not_tried": return { text: `Не пробовали: ${rest[0] ?? "?"} — ${stopWord(rest[1] ?? null)}`, names: names(rest.slice(2).join(":")) };
    case "files_missing": return { text: `Нет в альбоме: ${rest[0] ?? "?"}`, names: names(rest.slice(1).join(":")) };
    case "files_not_ready": return { text: `Ещё обрабатываются: ${rest[0] ?? "?"}`, names: names(rest.slice(1).join(":")) };
    case "order_differs": return { text: `Порядок другой с ${rest[0] ?? "?"}-го файла`, names: names(rest.slice(1).join(":")) };
    case "cards_not_renamed": return { text: `Без нового имени: ${rest[0] ?? "?"}`, names: names(rest.slice(1).join(":")) };
    case "album_not_read": return { text: "Альбом не прочитался после заливки", names: [] };
    case "album_gone": return { text: "Альбома больше нет на странице", names: [] };
    case "album_contents_not_read": return { text: "Hub не прочитал, что уже в альбоме", names: [] };
    case "album_create":
      return { text: NOT_CONFIRMED.test(tail) ? "Ответ на создание альбома потерян" : tail.endsWith("_not_read") ? "Альбомы не прочитались после создания" : "Альбом не создан", names: [] };
    case "album_media":
      return { text: tail === "not_sent" ? "Файлы залиты, в альбом не добавлены" : NOT_CONFIRMED.test(tail) ? "Добавление в альбом не подтверждено" : "Файлы не добавились в альбом", names: [] };
    case "album_rename": return { text: "Файлы не переименованы", names: [] };
    case "album_read": return { text: "Альбом не прочитался после заливки", names: [] };
    case "no_file_landed": return { text: "Ни один файл не залит", names: [] };
    case "three_failures":
    case "price_exceeded": return { text: `Загрузки остановлены: ${stopWord(head)}`, names: [] };
    case "album_over_daily_credits": return { text: "Дороже всего дневного потолка альбомов", names: [] };
    case "not_sent": {
      const word = holdWord(tail);
      return word === null ? null : { text: `Не отправлен: ${word}`, names: [] };
    }
    default: return null;
  }
}

/** An album's reason in parts, or null when it is not an album's (a post's reason reads as before). */
export function albumReasonParts(reason: string | null): AlbumReasonPart[] | null {
  if (reason === null || reason === "") return null;
  if (reason.startsWith("held: ")) {
    const word = holdWord(reason.slice("held: ".length));
    return word === null ? null : [{ text: `Ждёт: ${word}`, names: [] }];
  }
  if (reason.startsWith("not_sent:")) {
    const word = holdWord(reason.slice("not_sent:".length));
    return word === null ? null : [{ text: `Не отправлен: ${word}`, names: [] }];
  }
  const parts = reason.split(";").map(albumPart);
  const known = parts.filter((part): part is AlbumReasonPart => part !== null);
  return known.length === 0 ? null : known;
}

/** An album's reason as one line: its first part, and how many more. */
export function albumReasonLabel(reason: string | null): string | null {
  const parts = albumReasonParts(reason);
  if (parts === null) return null;
  const first = parts[0]!.text;
  return parts.length > 1 ? `${first} · ещё ${parts.length - 1}` : first;
}

// ── money and sizes ──────────────────────────────────────────────────────────

const numberFormat = new Intl.NumberFormat("ru-RU");

export function creditsLabel(value: number): string {
  return `${numberFormat.format(value)} ${ruPlural(value, "кредит", "кредита", "кредитов")}`;
}

/** «≈ $8,17»: dollars of credits (display only). */
export function usdLabel(credits: number, centsPer1000: number): string {
  return `≈ $${millsToDecimalString(millsFromCreditsAt(credits, centsPer1000)).slice(0, -1).replace(".", ",")}`;
}

export function bytesLabel(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1).replace(".", ",")} ГБ`;
  if (bytes >= 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000_000))} МБ`;
  return `${Math.max(1, Math.round(bytes / 1_000))} КБ`;
}

// ── the run ──────────────────────────────────────────────────────────────────

/** A file's state as a short word on the card. */
export const ALBUM_FILE_STATE: Readonly<Record<PublicationAlbumRun["fileList"][number]["state"], { word: string; tone: string }>> = {
  pending: { word: "ждёт", tone: "muted" },
  in_album: { word: "уже в альбоме", tone: "good" },
  reused: { word: "уже на странице", tone: "good" },
  uploading: { word: "заливается", tone: "info" },
  uploaded: { word: "залит", tone: "good" },
  failed: { word: "отказ", tone: "danger" },
  unknown: { word: "неизвестно", tone: "warning" },
  too_big: { word: "руками", tone: "warning" },
  not_tried: { word: "не пробовали", tone: "muted" },
};

/** «31 из 87»: the files in the album by now (uploaded or taken), of all. */
export function albumLanded(run: Pick<PublicationAlbumRun, "done" | "reused" | "files">): string {
  return `${run.done + run.reused} из ${run.files}`;
}

/** The feed row's line of a running album: «Залито 31 из 87 · IMG_0412.mov». */
export function albumProgressLine(run: PublicationAlbumRun): string | null {
  if (run.step === null || run.step === "done") return null;
  const current = run.currentFile === null ? "" : ` · ${run.currentFile}`;
  return `Залито ${albumLanded(run)}${current}`;
}

/** The files left out of a settled album: «отказ 2 · неизвестно 1 · руками 1». */
export function albumMissingLine(run: PublicationAlbumRun): string | null {
  const parts = [
    run.refused > 0 ? `отказ ${run.refused}` : null,
    run.unknown > 0 ? `неизвестно ${run.unknown}` : null,
    run.tooBig > 0 ? `руками ${run.tooBig}` : null,
    run.notTried > 0 ? `не пробовали ${run.notTried}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export { files as albumFilesCount };
