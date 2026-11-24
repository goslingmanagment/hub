import { describe, expect, it } from "vitest";

import {
  computePotDistributionLines,
  hasSaleLeftPot,
  potCoversPageDay,
  resolvePotParticipants,
  routePotOfSale,
  type PotPersonCandidate,
  type PotRoutingSpec,
} from "../apps/runtime/src/services/pots-rules.ts";
import type { RuleSlot } from "../apps/runtime/src/services/sale-rule.ts";

describe("Workboard pots pure rules (H11)", () => {
  describe("computePotDistributionLines", () => {
    it("splits equal shares with exact BigInt mills and deterministic remainder by sorted personCode", () => {
      const res = computePotDistributionLines({
        baseMills: 10_001,
        formula: { kind: "equal", params: {} },
        participants: ["kate", "alex", "den", "alex"],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.lines).toEqual([
        { personCode: "alex", baseMills: 3334, basis: "поровну на 3" },
        { personCode: "den", baseMills: 3334, basis: "поровну на 3" },
        { personCode: "kate", baseMills: 3333, basis: "поровну на 3" },
      ]);
      expect(res.lines.reduce((s, l) => s + l.baseMills, 0)).toBe(10_001);
      expect(res.normalizedFormula).toEqual({ kind: "equal", params: {} });
    });

    it("refuses equal formula with empty participants or non-positive base", () => {
      expect(computePotDistributionLines({
        baseMills: 10_000,
        formula: { kind: "equal", params: {} },
        participants: [],
      })).toMatchObject({ ok: false, reason: "no_participants" });

      expect(computePotDistributionLines({
        baseMills: 0,
        formula: { kind: "equal", params: {} },
        participants: ["alex"],
      })).toMatchObject({ ok: false, reason: "invalid_base" });
    });

    it("splits weighted shares exactly with deterministic remainder and validates weights", () => {
      const res = computePotDistributionLines({
        baseMills: 10_001,
        formula: { kind: "weights", params: { weights: { kate: 1, alex: 2, den: 1 } } },
        participants: ["alex", "den", "kate"],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.lines.reduce((s, l) => s + l.baseMills, 0)).toBe(10_001);
      expect(res.lines).toEqual([
        { personCode: "alex", baseMills: 5001, basis: "по весам (2/4)" },
        { personCode: "den", baseMills: 2500, basis: "по весам (1/4)" },
        { personCode: "kate", baseMills: 2500, basis: "по весам (1/4)" },
      ]);

      expect(computePotDistributionLines({
        baseMills: 10_000,
        formula: { kind: "weights", params: { weights: { alex: -1 } } },
        participants: ["alex"],
      })).toMatchObject({ ok: false, reason: "invalid_weights" });

      expect(computePotDistributionLines({
        baseMills: 10_000,
        formula: { kind: "weights", params: {} },
        participants: ["alex"],
      })).toMatchObject({ ok: false, reason: "invalid_weights" });
    });

    it("rejects nonnumeric and unrepresentable weights and requires active participants", () => {
      for (const weight of [true, Number.MAX_VALUE]) {
        expect(computePotDistributionLines({
          baseMills: 7, formula: { kind: "weights", params: { weights: { synthetic: weight } } }, participants: ["synthetic"],
        })).toMatchObject({ ok: false, reason: "invalid_weights" });
      }
      expect(computePotDistributionLines({
        baseMills: 7, formula: { kind: "weights", params: { weights: { synthetic: 1 } } }, participants: [],
      })).toMatchObject({ ok: false, reason: "no_participants" });
    });

    it("validates manual formula sum === baseMills and sorts participants", () => {
      const ok = computePotDistributionLines({
        baseMills: 50_000,
        formula: { kind: "manual", params: { shares: { kate: 15_000, alex: 35_000, den: 0 } } },
        participants: ["alex", "kate", "den"],
      });
      expect(ok.ok).toBe(true);
      if (!ok.ok) return;
      expect(ok.lines).toEqual([
        { personCode: "alex", baseMills: 35_000, basis: "вручную" },
        { personCode: "kate", baseMills: 15_000, basis: "вручную" },
      ]);
      expect(ok.normalizedFormula).toEqual({ kind: "manual", params: { shares: { alex: 35_000, kate: 15_000 } } });

      expect(computePotDistributionLines({
        baseMills: 50_000,
        formula: { kind: "manual", params: { shares: { alex: 30_000, kate: 15_000 } } },
        participants: ["alex", "kate"],
      })).toMatchObject({ ok: false, reason: "manual_sum_mismatch" });

      expect(computePotDistributionLines({
        baseMills: 50_000,
        formula: { kind: "manual", params: { shares: { alex: -10 } } },
        participants: ["alex"],
      })).toMatchObject({ ok: false, reason: "invalid_manual_shares" });
    });
  });

  describe("resolvePotParticipants", () => {
    const people: PotPersonCandidate[] = [
      { personId: 1, code: "alex", kind: "human", role: "chatter", state: "working", leftOn: null },
      { personId: 2, code: "kate", kind: "human", role: "chatter", state: "working", leftOn: null },
      { personId: 3, code: "den", kind: "human", role: "chatter", state: "left", leftOn: "2026-12-05" },
      { personId: 4, code: "olya", kind: "human", role: "team_lead", state: "working", leftOn: null },
      { personId: 5, code: "bot-helper", kind: "agent", role: "agent", state: "working", leftOn: null },
    ];

    it("resolves listed participants inclusively across dated windows", () => {
      const listed = [
        { personCode: "kate", fromDay: "2026-12-01", toDay: "2026-12-05" },
        { personCode: "alex", fromDay: "2026-12-05", toDay: null },
        { personCode: "den", fromDay: "2026-12-06", toDay: null },
      ];
      expect(resolvePotParticipants({
        day: "2026-12-05",
        mode: "listed",
        pageIds: [11],
        listed,
        people,
        workingPages: [],
        slots: [],
      })).toEqual(["alex", "kate"]);

      expect(resolvePotParticipants({
        day: "2026-12-06",
        mode: "listed",
        pageIds: [11],
        listed,
        people,
        workingPages: [],
        slots: [],
      })).toEqual(["alex", "den"]);
    });

    it("resolves page_workers from working pages union schedule cover slots and respects leftOn", () => {
      const workingPages = [
        { personId: 1, pageId: 11 },
        { personId: 3, pageId: 11 },
        { personId: 5, pageId: 11 }, // agent excluded
      ];
      const coverSlot: RuleSlot = {
        personId: 2,
        pageId: 11,
        startMinute: 600,
        endMinute: 960,
        weekdays: null,
        validFrom: "2026-12-04",
        validTo: "2026-12-04",
        day: "cover",
      };

      // On 2026-12-04: alex (working), den (leftOn 12-05 > 12-04), kate (one-day cover slot on page 11)
      expect(resolvePotParticipants({
        day: "2026-12-04",
        mode: "page_workers",
        pageIds: [11],
        listed: [],
        people,
        workingPages,
        slots: [coverSlot],
      })).toEqual(["alex", "den", "kate"]);

      // On 2026-12-05: den has left (leftOn <= day), kate's cover ended -> only alex
      expect(resolvePotParticipants({
        day: "2026-12-05",
        mode: "page_workers",
        pageIds: [11],
        listed: [],
        people,
        workingPages,
        slots: [coverSlot],
      })).toEqual(["alex"]);
    });
  });

  describe("routePotOfSale and hasSaleLeftPot", () => {
    const pagePot: PotRoutingSpec = {
      id: 1,
      code: "page-mia-1",
      pageIds: [11],
      intakeReasons: ["campaign", "post_tip"],
      opensOn: "2026-12-01",
      closesOn: null,
      state: "open",
    };
    const eventPot: PotRoutingSpec = {
      id: 2,
      code: "winter-event",
      pageIds: [11, 12],
      intakeReasons: [],
      opensOn: "2026-12-01",
      closesOn: "2026-12-10",
      state: "open",
    };

    it("handles cutover, page pots, explicit event pots, ambiguity, and closed/unknown codes", () => {
      expect(potCoversPageDay(eventPot, 11, "2026-12-10")).toBe(true);
      expect(potCoversPageDay(eventPot, 11, "2026-12-11")).toBe(false);

      // Before cutover or switch null
      expect(routePotOfSale(
        { pageId: 11, day: "2026-11-30", home: "pot", reason: "post_tip", pot: "obshak" },
        [pagePot],
        "2026-12-01",
      )).toEqual({ status: "before_cutover" });
      expect(routePotOfSale(
        { pageId: 11, day: "2026-12-02", home: "pot", reason: "post_tip", pot: "obshak" },
        [pagePot],
        null,
      )).toEqual({ status: "before_cutover" });

      // Unique page pot match
      expect(routePotOfSale(
        { pageId: 11, day: "2026-12-02", home: "pot", reason: "post_tip", pot: "obshak" },
        [pagePot, eventPot],
        "2026-12-01",
      )).toEqual({ status: "routed", potId: 1, potCode: "page-mia-1" });

      // Explicit event pot
      expect(routePotOfSale(
        { pageId: 12, day: "2026-12-05", home: "pot", reason: "decision", pot: "winter-event" },
        [pagePot, eventPot],
        "2026-12-01",
      )).toEqual({ status: "routed", potId: 2, potCode: "winter-event" });

      // Explicit pot outside closesOn
      expect(routePotOfSale(
        { pageId: 12, day: "2026-12-12", home: "pot", reason: "decision", pot: "winter-event" },
        [pagePot, eventPot],
        "2026-12-01",
      )).toEqual({ status: "unrouted", why: "closed_or_outside", matchingPotCodes: ["winter-event"] });

      // Unknown explicit code
      expect(routePotOfSale(
        { pageId: 11, day: "2026-12-02", home: "pot", reason: "decision", pot: "no-such-pot" },
        [pagePot],
        "2026-12-01",
      )).toEqual({ status: "unrouted", why: "unknown_code", matchingPotCodes: [] });

      // No matching page pot
      expect(routePotOfSale(
        { pageId: 12, day: "2026-12-02", home: "pot", reason: "campaign", pot: "obshak" },
        [pagePot, eventPot],
        "2026-12-01",
      )).toEqual({ status: "unrouted", why: "no_matching_page_pot", matchingPotCodes: [] });

      // Ambiguous page pots
      const secondPagePot: PotRoutingSpec = { ...pagePot, id: 3, code: "page-mia-1-dup" };
      expect(routePotOfSale(
        { pageId: 11, day: "2026-12-02", home: "pot", reason: "post_tip", pot: "obshak" },
        [secondPagePot, pagePot],
        "2026-12-01",
      )).toEqual({ status: "unrouted", why: "ambiguous_page_pot", matchingPotCodes: ["page-mia-1", "page-mia-1-dup"] });
    });

    it("does NOT mark already-distributed sales as having left when a pot is closed, but DOES when sale moves out", () => {
      const closedPagePot: PotRoutingSpec = { ...pagePot, state: "closed" };
      // Still home=pot on same page & day -> closing the pot does NOT trigger reversal!
      expect(hasSaleLeftPot(
        closedPagePot.code,
        { pageId: 11, day: "2026-12-02", home: "pot", reason: "post_tip", pot: "obshak" },
        "2026-12-01",
      )).toBe(false);

      // Sale moved to a chatter's shift -> HAS left!
      expect(hasSaleLeftPot(
        closedPagePot.code,
        { pageId: 11, day: "2026-12-02", home: "shift", reason: "decision", pot: null },
        "2026-12-01",
      )).toBe(true);

      // Sale moved to another explicit pot -> HAS left!
      expect(hasSaleLeftPot(
        closedPagePot.code,
        { pageId: 11, day: "2026-12-02", home: "pot", reason: "decision", pot: "winter-event" },
        "2026-12-01",
      )).toBe(true);

      // Sale vanished (undefined) -> HAS left!
      expect(hasSaleLeftPot(closedPagePot.code, undefined, "2026-12-01")).toBe(true);
    });
  });
});
