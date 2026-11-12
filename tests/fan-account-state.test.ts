import { describe, expect, it } from "vitest";

import {
  clientAccountSignalDisagrees,
  clientAccountSignalIsNews,
  fanAccountState,
  type FanAccountStateFacts,
} from "@agency_hub_core/db";

// A fan's account state on one page (0374, fan-account-state-v1): the page's
// own answer, when its «not seen» streak began, the public check (Fansly) or
// the contactability (OnlyFans).

const CHECKED = "2026-11-10T12:00:00.000Z";
const SINCE = "2026-11-01T08:00:00.000Z";

function fansly(facts: Partial<FanAccountStateFacts>): FanAccountStateFacts {
  return {
    platform: "fansly",
    accountProbeResolved: false,
    accountProbeAt: new Date(CHECKED),
    accountMissSince: new Date(SINCE),
    publicFound: null,
    publicCheckedAt: null,
    accountContactability: null,
    ...facts,
  };
}

describe("fanAccountState", () => {
  it("is null while the page never answered", () => {
    expect(fanAccountState(fansly({ accountProbeAt: null, accountProbeResolved: null, accountMissSince: null }))).toBeNull();
    expect(fanAccountState(fansly({ accountProbeResolved: null }))).toBeNull();
    expect(fanAccountState({ ...fansly({ accountProbeAt: null, accountProbeResolved: null }), platform: "onlyfans" })).toBeNull();
  });

  it("Fansly: a returned account is seen, with no start", () => {
    expect(fanAccountState(fansly({ accountProbeResolved: true, accountMissSince: null, publicFound: false, publicCheckedAt: CHECKED })))
      .toEqual({ state: "seen", since: null, checkedAt: CHECKED });
  });

  it("Fansly: a miss takes its cause from a public check made at or after the streak began", () => {
    expect(fanAccountState(fansly({ publicFound: true, publicCheckedAt: "2026-11-02T00:00:00Z" })))
      .toEqual({ state: "blocked", since: SINCE, checkedAt: CHECKED });
    expect(fanAccountState(fansly({ publicFound: false, publicCheckedAt: "2026-11-02T00:00:00Z" })))
      .toEqual({ state: "deleted", since: SINCE, checkedAt: CHECKED });
    // At the very start is after it.
    expect(fanAccountState(fansly({ publicFound: false, publicCheckedAt: SINCE }))?.state).toBe("deleted");
  });

  it("Fansly: a public check older than the streak, or none, says nothing — unchecked", () => {
    expect(fanAccountState(fansly({ publicFound: true, publicCheckedAt: "2026-10-31T00:00:00Z" })))
      .toEqual({ state: "unchecked", since: SINCE, checkedAt: CHECKED });
    expect(fanAccountState(fansly({}))).toEqual({ state: "unchecked", since: SINCE, checkedAt: CHECKED });
  });

  it("Fansly: a streak whose start is unknown takes any public check, and says so with a null start", () => {
    expect(fanAccountState(fansly({ accountMissSince: null, publicFound: false, publicCheckedAt: "2026-01-01T00:00:00Z" })))
      .toEqual({ state: "deleted", since: null, checkedAt: CHECKED });
    expect(fanAccountState(fansly({ accountMissSince: null, publicFound: true, publicCheckedAt: "2026-01-01T00:00:00Z" })))
      .toEqual({ state: "blocked", since: null, checkedAt: CHECKED });
    expect(fanAccountState(fansly({ accountMissSince: null }))).toEqual({ state: "unchecked", since: null, checkedAt: CHECKED });
  });

  it("OnlyFans: gone is deleted, blocked is blocked, any other contactability is seen", () => {
    const onlyfans = (accountContactability: string | null, accountProbeResolved: boolean) => fanAccountState({
      ...fansly({ accountContactability, accountProbeResolved, accountMissSince: accountProbeResolved ? null : SINCE }),
      platform: "onlyfans",
      // The public reader is Fansly's: an OnlyFans row never reads it.
      publicFound: true,
      publicCheckedAt: CHECKED,
    });
    expect(onlyfans("gone", false)).toEqual({ state: "deleted", since: SINCE, checkedAt: CHECKED });
    expect(onlyfans("blocked", false)).toEqual({ state: "blocked", since: SINCE, checkedAt: CHECKED });
    for (const contactability of ["contactable", "unavailable", "restricted", "unknown"]) {
      expect(onlyfans(contactability, true), contactability).toEqual({ state: "seen", since: null, checkedAt: CHECKED });
    }
    // A row without a contactability goes by the answer.
    expect(onlyfans(null, true)?.state).toBe("seen");
    expect(onlyfans(null, false)).toEqual({ state: "unchecked", since: SINCE, checkedAt: CHECKED });
  });
});

describe("a browser's word on an account", () => {
  it("disagrees when it does not see a fan the page sees or never asked about, or sees one the page does not", () => {
    expect(clientAccountSignalDisagrees(false, true)).toBe(true);
    expect(clientAccountSignalDisagrees(false, null)).toBe(true);
    expect(clientAccountSignalDisagrees(true, false)).toBe(true);
    // Agreement, and «never asked + seen», are nothing.
    expect(clientAccountSignalDisagrees(false, false)).toBe(false);
    expect(clientAccountSignalDisagrees(true, true)).toBe(false);
    expect(clientAccountSignalDisagrees(true, null)).toBe(false);
  });

  it("is news unless the link holds the same word still waiting for the page's answer", () => {
    const answered = new Date("2026-11-10T12:00:00Z");
    const link = (accountClientSeen: boolean | null, accountClientSeenAt: Date | null, accountProbeAt: Date | null = answered) => ({
      accountProbeResolved: accountProbeAt === null ? null : true,
      accountProbeAt,
      accountClientSeen,
      accountClientSeenAt,
    });
    expect(clientAccountSignalIsNews(false, link(null, null))).toBe(true);
    // The same word, after the page's answer: still waiting, nothing new.
    expect(clientAccountSignalIsNews(false, link(false, new Date("2026-11-10T12:05:00Z")))).toBe(false);
    // The page answered after the word: a new disagreement is news again.
    expect(clientAccountSignalIsNews(false, link(false, new Date("2026-11-10T11:55:00Z")))).toBe(true);
    // Never asked: the word waits for the first answer.
    expect(clientAccountSignalIsNews(false, link(false, new Date("2026-11-10T11:55:00Z"), null))).toBe(false);
    // Another word is news.
    expect(clientAccountSignalIsNews(false, link(true, new Date("2026-11-10T12:05:00Z")))).toBe(true);
    // Agreement never is.
    expect(clientAccountSignalIsNews(true, link(null, null))).toBe(false);
  });
});
