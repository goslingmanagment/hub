import { describe, expect, it } from "vitest";

import { albumAccountFor } from "../apps/runtime/src/services/person-door.ts";
import { FANSLY_CHECK_REASONS, FANSLY_CHECK_REASON_PREFIXES } from "../apps/runtime/src/services/publications-fansly-checks.ts";
import {
  ONLYFANS_CHECK_REASONS,
  ONLYFANS_CHECK_REASON_PREFIXES,
  PUBLICATION_MATCH_AMBIGUITIES,
} from "../apps/runtime/src/services/publications-onlyfans-checks.ts";

import { albumRunWords, statusReasonWords } from "../packages/contracts/src/publication-words.ts";

// The one table of publications' words (products package C2): what Hub's screen said, the person's door now carries
// to ContentOps. A code it does not know reads as «другая причина», never as the code.

describe("publications' words", () => {
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
