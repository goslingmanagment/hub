import { describe, expect, it } from "vitest";

import { albumAccountFor } from "../apps/runtime/src/services/person-door.ts";
import { FANSLY_CHECK_REASONS, FANSLY_CHECK_REASON_PREFIXES } from "../apps/runtime/src/services/publications-fansly-checks.ts";
import {
  ONLYFANS_CHECK_REASONS,
  ONLYFANS_CHECK_REASON_PREFIXES,
  PUBLICATION_MATCH_AMBIGUITIES,
} from "../apps/runtime/src/services/publications-onlyfans-checks.ts";

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

  it("has words for every reason a check can conclude a status with, never «Другая причина»", () => {
    // From the checks' own lists (their `conclude` takes nothing else): the plain codes, and each prefix with every
    // ambiguity of a match or a detail as the checks write it.
    const detail: Record<string, readonly string[]> = {
      "absent_unproven:": ["post_id_kept_unverified,timeline_short", "schedule_incomplete"],
      "schedule_incomplete:": ["read_budget,day_over_100"],
    };
    const codes = [
      ...FANSLY_CHECK_REASONS,
      ...ONLYFANS_CHECK_REASONS,
      ...[...FANSLY_CHECK_REASON_PREFIXES, ...ONLYFANS_CHECK_REASON_PREFIXES].flatMap((prefix) =>
        (detail[prefix] ?? PUBLICATION_MATCH_AMBIGUITIES).map((tail) => `${prefix}${tail}`)),
    ];
    const wordless = codes.filter((code) => {
      const words = statusReasonWords(code);
      return words === null || words === "Другая причина" || !/[а-яё]/i.test(words);
    });
    expect(wordless).toEqual([]);
    // Production's two live unknown posts (15, 19): the Fansly check's prefixed ambiguity.
    expect(statusReasonWords("timeline_could_be_unproven")).toBe("на площадке есть похожие посты, какой из них этот, неясно");
  });

  it("gives the OnlyFans API account's ceiling and balance to the owner alone; the album's own run and cost to both", () => {
    const run = {
      step: "uploads", files: 24, done: 18, reused: 1, refused: 2, unknown: 0, notTried: 3, tooBig: 0, currentFile: "IMG_0420.mov",
      estimateCredits: 3600, spentCredits: 2340, stopReason: "three_failures",
      fileList: [{ name: "IMG_0420.mov", bytes: 760_000_000, state: "uploading", credits: 0 }],
      account: { dailyCredits: 20000, spentToday: 4100, left: 15900, balance: 61000, centsPer1000: 149 }, linkMaxBytes: 1_000_000_000,
    };
    const owner = albumRunWords(run, { account: true });
    const manager = albumRunWords(run, { account: false });
    expect(owner.ceiling).toMatch(/на балансе 61\s?000/);
    expect(manager.ceiling).toBeNull();
    // Her own: the run, the album's cost, why the uploads stopped.
    for (const words of [owner, manager]) {
      expect(words).toMatchObject({ landed: "Залито 19 из 24", stop: "три сбоя подряд" });
      expect(words.price).toMatch(/^Потрачено 2\s?340 из 3\s?600 кредитов/);
    }
    // The door's answer: the raw account goes to the owner alone.
    const publication = { id: 1, albumRun: run };
    expect(albumAccountFor("owner", publication).albumRun.account).toEqual(run.account);
    expect(albumAccountFor("content_manager", publication).albumRun.account).toBeNull();
    expect(albumAccountFor("content_manager", { id: 2, albumRun: null })).toEqual({ id: 2, albumRun: null });
  });
});
