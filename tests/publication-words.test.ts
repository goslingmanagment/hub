import { describe, expect, it } from "vitest";

import {
  albumReasonParts,
  albumRunWords,
  approveRefusalWords,
  autostopReasonWords,
  commandNoteWords,
  deleteResultWords,
  findingWords,
  statusReasonWords,
  withdrawResultWords,
} from "../packages/contracts/src/publication-words.ts";

// The one table of publications' words (products package C2): what Hub's screen said, the person's door now carries
// to ContentOps. A code it does not know reads as «другая причина», never as the code.

describe("publications' words", () => {
  it("says a status's reason, its prefixed codes too, never the code", () => {
    expect(statusReasonWords("not_sent:upload_part_unknown")).toBe("запрос поста не уходил");
    expect(statusReasonWords("absent_unproven:read_failed")).toBe("поста не видно, но доказать, что он не вышел, Hub пока не может");
    expect(statusReasonWords("fansly_http_502")).toBe("Fansly отказал (ответ 502)");
    expect(statusReasonWords("answered_went_out")).toBe("ответ человека: ушло");
    expect(statusReasonWords("no_such_code_ever")).toBe("Другая причина");
    expect(statusReasonWords(null)).toBeNull();
  });

  it("reads a vault album's reason part by part, with the files each names", () => {
    expect(albumReasonParts("files_failed:2/87:IMG_1.mov=x,IMG_2.mov=y;three_failures")).toEqual([
      { text: "Отказ: 2 из 87", names: ["IMG_1.mov", "IMG_2.mov"] },
      { text: "Загрузки остановлены: три сбоя подряд", names: [] },
    ]);
    expect(statusReasonWords("files_failed:2/87:IMG_1.mov;three_failures")).toBe("отказ: 2 из 87 · ещё 1");
  });

  it("says an album's run: progress, the file going up, the files left out, the price and the day's ceiling", () => {
    const words = albumRunWords({
      step: "uploads", files: 87, done: 30, reused: 1, refused: 2, unknown: 0, notTried: 0, tooBig: 1, currentFile: "IMG_0412.mov",
      estimateCredits: 5486, spentCredits: 1200, stopReason: null,
      fileList: [{ name: "IMG_0412.mov", bytes: 2_400_000_000, state: "uploading", credits: 0 }],
      account: { dailyCredits: 20000, spentToday: 3000, left: 17000, balance: 90000, centsPer1000: 149 }, linkMaxBytes: 1_000_000_000,
    });
    expect(words).toMatchObject({ landed: "Залито 31 из 87", current: "IMG_0412.mov", missing: "Отказ 2 · Руками, больше 1,0 ГБ 1" });
    expect(words.price).toMatch(/^Потрачено 1\s?200 из 5\s?486 кредитов ≈ \$1,7/);
    expect(words.ceiling).toMatch(/^Потолок альбомов в сутки 20\s?000 кредитов/);
    expect(words.files).toEqual([{ name: "IMG_0412.mov", size: "2,4 ГБ", state: "заливается" }]);
  });

  it("says the actions' outcomes, a page's stop and a draft's checks", () => {
    expect(approveRefusalWords("status_scheduled")).toBe("пост уже не ждёт утверждения: «В расписании»");
    expect(withdrawResultWords({ outcome: "refused", reason: "too_close_to_publish_time" })).toBe("Не убран: до выхода меньше 5 минут");
    expect(withdrawResultWords({ outcome: "refused", reason: "тестовая страница: на площадку не отправляется" })).toBe("Не убран: тестовая страница: на площадку не отправляется");
    expect(deleteResultWords({ outcome: "refused", reason: "no_platform_ref" })).toBe("Не удалён: у публикации нет номера поста на площадке");
    expect(autostopReasonWords("browser_login_lost")).toBe("Fansly вышел из аккаунта в браузере страницы");
    expect(findingWords({ code: "media_not_on_page", severity: "blocking", mediaKey: "vault:m1", at: null, publicationId: null, detail: {} },
      [{ role: "media", position: 1, source: "vault", mediaRef: "m1" }])).toBe("Файл 2 из медиатеки: его нет среди файлов этой страницы");
  });

  it("says what happened to a withdrawal or a deletion Hub sent, when the status does not", () => {
    expect(commandNoteWords({ status: "scheduled", platform: "fansly", withdrawal: { state: "confirmed" }, deletion: null })).toBe("Fansly принял команду — Hub проверяет расписание");
    expect(commandNoteWords({ status: "published", platform: "fansly", withdrawal: null, deletion: { state: "rejected" } })).toBe("Fansly отказал в удалении: пост на стене, удалите на площадке");
    expect(commandNoteWords({ status: "withdrawn", platform: "fansly", withdrawal: { state: "confirmed" }, deletion: null })).toBeNull();
  });
});
