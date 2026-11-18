import { describe, expect, it } from "vitest";

import { proposeTrafficSource, type TrafficSourceCandidate } from "@agency_hub_core/shared";

// Which source a link without one probably is (traffic-source-proposal.ts): one source or none — a tie or a weak
// match proposes nothing.

const SOURCES: TrafficSourceCandidate[] = [
  { key: "mia.twitter", title: "X (Twitter)", linkNames: ["X · ссылка в био", "Закреп в профиле"] },
  { key: "mia.reddit", title: "Reddit", linkNames: ["Reddit · основной профиль", "Пробные 7 дней · Reddit"] },
  { key: "mia.tubes", title: "Видеоплощадки", linkNames: ["Pornhub · профиль", "Xfree · профиль", "Redgifs клипы"] },
  { key: "mia.porntoki", title: "Порнтоки", linkNames: [] },
];

describe("proposeTrafficSource", () => {
  it("reads the name against the source's title whatever the case, punctuation and number at the end", () => {
    expect(proposeTrafficSource("Twitter Rounds Two", SOURCES)).toBe("mia.twitter");
    expect(proposeTrafficSource("reddit2 — комменты", SOURCES)).toBe("mia.reddit");
    expect(proposeTrafficSource("REDDIT_3", SOURCES)).toBe("mia.reddit");
  });

  it("reads one alphabet as the other", () => {
    expect(proposeTrafficSource("Реддит, новая ветка", SOURCES)).toBe("mia.reddit");
    expect(proposeTrafficSource("Твиттер 2", SOURCES)).toBe("mia.twitter");
    expect(proposeTrafficSource("PornToki ноябрь", SOURCES)).toBe("mia.porntoki");
  });

  it("takes two words of a source's links' names, never one", () => {
    expect(proposeTrafficSource("Redgifs клипы 2", SOURCES)).toBe("mia.tubes");
    expect(proposeTrafficSource("Redgifs осень", SOURCES)).toBeNull();
  });

  it("proposes nothing for a tie, a second plausible source, generic words or no name", () => {
    expect(proposeTrafficSource("Reddit → Twitter crosspost", SOURCES)).toBeNull();
    expect(proposeTrafficSource("Пробные 30 дней · бывшие фаны", SOURCES)).toBeNull();
    expect(proposeTrafficSource("Ссылка 4", SOURCES)).toBeNull();
    expect(proposeTrafficSource(null, SOURCES)).toBeNull();
    expect(proposeTrafficSource("Reddit", [])).toBeNull();
  });

  it("ignores a word every source shares (the model's name in the keys)", () => {
    expect(proposeTrafficSource("Mia новая", SOURCES)).toBeNull();
    const twoReddits: TrafficSourceCandidate[] = [
      { key: "mia.reddit", title: "Reddit", linkNames: [] },
      { key: "mia.reddit-vip", title: "Reddit VIP", linkNames: [] },
    ];
    expect(proposeTrafficSource("Reddit 5", twoReddits)).toBeNull();
  });
});
