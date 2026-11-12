import { describe, expect, it } from "vitest";

import type { AgentTeamSale, AgentTeamSalesResponse, AgentTeamWork } from "@agency_hub_core/contracts";
import type { PersonScheduleSlotRow } from "@agency_hub_core/db";

import { leftAtOf, ruleSlotsOf } from "../apps/runtime/src/services/sale-homes.ts";
import { slotsOfFile } from "../apps/runtime/src/services/sale-rule-cli.ts";
import { compareSaleRule, type LedgerExport, type LedgerFactHome } from "../apps/runtime/src/services/sale-rule-compare.ts";
import {
  LEDGER_GO_RULE,
  POT_OBSHAK,
  homeOfSale,
  homesOfSales,
  slotRuns,
  weekdayOfDay,
  type RuleMark,
  type RuleSale,
  type RuleSlot,
  type RuleWeekday,
  type RuleWork,
  type SaleHome,
  type SaleShare,
} from "../apps/runtime/src/services/sale-rule.ts";

// Whose a sale is (sale-rule.ts). The first block is ledger's internal/split/split_test.go (origin/main 52968b6) case
// by case: the same inputs give the same homes, so Hub's port and ledger's Go are pinned to one set of examples. The
// owner's newer answers (Gengar's SKILL.md §4, 2026-11-12) follow, each against Go's answer for the same facts.
// Synthetic team: chatters 101, 102 and 103, a team lead 201; pages page-a and page-b; times are Moscow, November 2026.

const PAGE_A = 1;
const msk = (at: string) => Date.parse(`${at.replace(" ", "T")}:00+03:00`);

function work(kind: RuleWork["kind"], user: number, from: string, to: string): RuleWork {
  const startedAt = msk(from);
  return { ref: `${user}:${new Date(startedAt).toISOString()}`, userId: user, kind, startedAt, endedAt: msk(to) };
}
const shift = (user: number, from: string, to: string) => work("shift", user, from, to);
const visit = (user: number, from: string, to: string) => work("visit", user, from, to);

function sale(kind: RuleSale["kind"], at: string, net: number, ...holders: RuleWork[]): RuleSale {
  return {
    ref: `t-${at}`, pageId: PAGE_A, kind, netMills: net, occurredAt: msk(at), holders: holders.map((one) => one.ref), ppvSender: null, postTip: false,
    campaign: false, lastWriter: null, marks: [], resolution: null, claimedBy: null,
  };
}

const ppvBy = (one: RuleSale, user: number, role: "owner" | "team_lead" | "chatter", leftAt: number | null = null): RuleSale => ({
  ...one, ppvSender: { userId: user, role, leftAt },
});

const whole100 = (one: RuleWork, net: number): SaleShare[] => [{ workRef: one.ref, userId: one.userId, percent: 100, mills: net }];

function expectHome(got: SaleHome, kind: SaleHome["kind"], reason: SaleHome["reason"], shares: SaleShare[] = []) {
  expect({ kind: got.kind, reason: got.reason, shares: got.shares }).toEqual({ kind, reason, shares });
}

const mark = (userId: number, kind: RuleMark["mark"], extra: Partial<RuleMark> = {}): RuleMark => ({
  userId, mark: kind, shareWith: null, ownAmountMills: null, confirmed: false, ...extra,
});

// A week after the sales: every PPV's wait is over unless a test says otherwise.
const later = msk("2026-11-20 12:00");

describe("ledger split_test.go, case by case", () => {
  it("a PPV bought in a colleague's shift goes to the sender's shift on another page", () => {
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    const elsewhere = shift(102, "2026-11-05 12:00", "2026-11-05 18:00");
    const ppv = ppvBy(sale("ppv", "2026-11-05 14:00", 24_000, holder), 102, "chatter");
    expectHome(homeOfSale(ppv, [holder, elsewhere], [], later), "shift", "ppv_sender_other_page", whole100(elsewhere, 24_000));
  });

  it("a PPV bought between the sender's shifts waits and lands in their next shift within seven days", () => {
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    const ppv = ppvBy(sale("ppv", "2026-11-05 16:44", 30_000, holder), 102, "chatter");
    const now = msk("2026-11-06 12:00");
    const got = homeOfSale(ppv, [holder], [], now);
    expectHome(got, "waiting", "ppv_sender_waiting");
    expect(got.waitsUntil).toBe(msk("2026-11-12 16:44"));
    // The sender's shifts: one after the purchase within the week, a later one; the first takes it.
    const night = shift(102, "2026-11-06 03:39", "2026-11-06 11:00");
    const weekLater = shift(102, "2026-11-11 10:00", "2026-11-11 18:00");
    expectHome(homeOfSale(ppv, [weekLater, holder, night], [], now), "shift", "ppv_sender_next_shift", whole100(night, 30_000));
    // A shift that begins exactly 7 days after the purchase is still within the wait.
    const edge = shift(102, "2026-11-12 16:44", "2026-11-12 22:00");
    expectHome(homeOfSale(ppv, [holder, edge], [], later), "shift", "ppv_sender_next_shift", whole100(edge, 30_000));
  });

  it("a PPV whose sender's next shift is not within seven days is nobody's", () => {
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    const ppv = ppvBy(sale("ppv", "2026-11-05 16:44", 30_000, holder), 102, "chatter");
    const tooLate = shift(102, "2026-11-12 16:45", "2026-11-12 22:00");
    expectHome(homeOfSale(ppv, [holder, tooLate], [], msk("2026-11-12 16:44")), "nobody", "ppv_sender_no_shift");
    expectHome(homeOfSale(ppv, [holder], [], msk("2026-11-12 16:43")), "waiting", "ppv_sender_waiting");
  });

  it("the sender's own shift holding their PPV keeps it", () => {
    const mine = shift(102, "2026-11-05 10:00", "2026-11-05 18:00");
    const colleague = shift(101, "2026-11-05 12:00", "2026-11-05 20:00");
    const ppv = { ...ppvBy(sale("ppv", "2026-11-05 14:00", 20_000, colleague, mine), 102, "chatter"), lastWriter: 101 };
    expectHome(homeOfSale(ppv, [colleague, mine], [], later), "shift", "ppv_sender", whole100(mine, 20_000));
  });

  it("the sender's own look-in keeps their PPV", () => {
    const look = visit(102, "2026-11-05 12:00", "2026-11-05 12:50");
    const ppv = ppvBy(sale("ppv", "2026-11-05 12:30", 50_000, look), 102, "chatter");
    // Their shift later that day does not take it: the look-in holding it does.
    const afternoon = shift(102, "2026-11-05 15:00", "2026-11-05 22:00");
    expectHome(homeOfSale(ppv, [look, afternoon], [], later), "visit", "ppv_sender", whole100(look, 50_000));
  });

  it("a PPV of a team lead or without author stays with the shift that holds it", () => {
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    const lead = shift(201, "2026-11-05 13:00", "2026-11-05 20:00");
    const byLead = ppvBy(sale("ppv", "2026-11-05 14:00", 20_000, holder), 201, "team_lead");
    expectHome(homeOfSale(byLead, [holder, lead], [], later), "shift", "holder", whole100(holder, 20_000));
    const noAuthor = sale("ppv", "2026-11-05 14:10", 20_000, holder);
    expectHome(homeOfSale(noAuthor, [holder, lead], [], later), "shift", "holder", whole100(holder, 20_000));
  });

  it("a post tip and a Campaign contribution go to the pot whoever held the page", () => {
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    const postTip = { ...sale("tip", "2026-11-05 14:00", 300_000, holder), postTip: true };
    const campaign = { ...sale("tip", "2026-11-05 15:00", 100_000, holder), campaign: true };
    expect(homesOfSales([postTip, campaign], [holder], [], later)).toEqual([
      { kind: "pot", reason: "post_tip", pot: POT_OBSHAK, shares: [], waitsUntil: null, slotJunction: false },
      { kind: "pot", reason: "campaign", pot: POT_OBSHAK, shares: [], waitsUntil: null, slotJunction: false },
    ]);
  });

  it("a renewal and a chat tip stay with the one shift that holds them whoever wrote last", () => {
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    const renewal = { ...sale("subscription", "2026-11-05 14:00", 40_000, holder), lastWriter: 102 };
    const tip = sale("tip", "2026-11-05 15:00", 10_000, holder);
    const homes = homesOfSales([renewal, tip], [holder], [], later);
    expectHome(homes[0]!, "shift", "holder", whole100(holder, 40_000));
    expectHome(homes[1]!, "shift", "holder", whole100(holder, 10_000));
  });

  it("two holders give the sale to the last writer", () => {
    const a = shift(101, "2026-11-05 09:00", "2026-11-05 13:00");
    const b = shift(102, "2026-11-05 10:30", "2026-11-05 14:00");
    const one = { ...sale("tip", "2026-11-05 11:00", 30_000, a, b), lastWriter: 102 };
    expectHome(homeOfSale(one, [a, b], [], later), "shift", "last_writer", whole100(b, 30_000));
  });

  it("two holders, none of them last, wait for a decision", () => {
    const a = shift(101, "2026-11-05 09:00", "2026-11-05 13:00");
    const b = shift(102, "2026-11-05 10:30", "2026-11-05 14:00");
    const one = sale("tip", "2026-11-05 11:00", 30_000, a, b);
    expectHome(homeOfSale(one, [a, b], [], later), "decide", "no_last_writer");
    // A third chatter wrote last: still neither of theirs.
    expectHome(homeOfSale({ ...one, lastWriter: 103 }, [a, b], [], later), "decide", "no_last_writer");
  });

  it("a decision the owner split goes by his percents, the last taking the rounding", () => {
    const a = shift(101, "2026-11-05 09:00", "2026-11-05 13:00");
    const b = shift(102, "2026-11-05 10:30", "2026-11-05 14:00");
    const one: RuleSale = {
      ...sale("tip", "2026-11-05 11:00", 1_001, a, b),
      resolution: [{ userId: 102, percent: 33 }, { userId: 101, percent: 67 }],
      // The owner's split wins over the marks.
      marks: [mark(101, "mine", { confirmed: true })],
    };
    expectHome(homeOfSale(one, [a, b], [], later), "shift", "owner_split", [
      { workRef: b.ref, userId: 102, percent: 33, mills: 330 },
      { workRef: a.ref, userId: 101, percent: 67, mills: 671 },
    ]);
  });

  it("a decision of two mutual «делим» marks is halves, the odd mill to the lower user", () => {
    const a = shift(101, "2026-11-05 09:00", "2026-11-05 13:00");
    const b = shift(102, "2026-11-05 10:30", "2026-11-05 14:00");
    const marks = [mark(102, "share", { shareWith: 101, confirmed: true }), mark(101, "share", { shareWith: 102 })];
    const one = { ...sale("tip", "2026-11-05 11:00", 30_001, a, b), marks };
    expectHome(homeOfSale(one, [a, b], [], later), "shift", "marks", [
      { workRef: a.ref, userId: 101, percent: 50, mills: 15_001 },
      { workRef: b.ref, userId: 102, percent: 50, mills: 15_000 },
    ]);
    // Neither report confirmed: the marks are a draft, it still waits.
    const draft = { ...one, marks: [{ ...marks[0]!, confirmed: false }, marks[1]!] };
    expectHome(homeOfSale(draft, [a, b], [], later), "decide", "no_last_writer");
  });

  it("a decision of one «моё» mark is that chatter's, or only their own amount", () => {
    const a = shift(101, "2026-11-05 09:00", "2026-11-05 13:00");
    const b = shift(102, "2026-11-05 10:30", "2026-11-05 14:00");
    const base = sale("tip", "2026-11-05 11:00", 40_000, a, b);
    const with102 = (extra: Partial<RuleMark>) => ({ ...base, marks: [mark(101, "not_mine", { confirmed: true }), mark(102, "mine", { confirmed: true, ...extra })] });
    expectHome(homeOfSale(with102({}), [a, b], [], later), "shift", "marks", whole100(b, 40_000));
    // An own amount below the net keeps only that; the rest is nobody's.
    expectHome(homeOfSale(with102({ ownAmountMills: 10_000 }), [a, b], [], later), "shift", "marks", [{ workRef: b.ref, userId: 102, percent: 25, mills: 10_000 }]);
    // One above the net claims the net, never more.
    expectHome(homeOfSale(with102({ ownAmountMills: 90_000 }), [a, b], [], later), "shift", "marks", whole100(b, 40_000));
    // A «моё» of a report not confirmed decides nothing yet.
    expectHome(homeOfSale(with102({ ownAmountMills: 90_000, confirmed: false }), [a, b], [], later), "decide", "no_last_writer");
  });

  it("marks that disagree wait for the owner", () => {
    const a = shift(101, "2026-11-05 09:00", "2026-11-05 13:00");
    const b = shift(102, "2026-11-05 10:30", "2026-11-05 14:00");
    const base = sale("tip", "2026-11-05 11:00", 40_000, a, b);
    expectHome(homeOfSale({ ...base, marks: [mark(101, "mine", { confirmed: true }), mark(102, "mine", { confirmed: true })] }, [a, b], [], later), "decide", "marks_disagree");
    // A «делим» the colleague did not answer with theirs.
    const unanswered = [mark(101, "share", { shareWith: 102, confirmed: true }), mark(102, "not_mine", { confirmed: true })];
    expectHome(homeOfSale({ ...base, marks: unanswered }, [a, b], [], later), "decide", "marks_disagree");
  });

  it("every holder confirming «не моё» makes the sale nobody's", () => {
    const a = shift(101, "2026-11-05 09:00", "2026-11-05 13:00");
    const b = shift(102, "2026-11-05 10:30", "2026-11-05 14:00");
    const base = sale("tip", "2026-11-05 11:00", 40_000, a, b);
    const one = [mark(101, "not_mine", { confirmed: true })];
    expectHome(homeOfSale({ ...base, marks: one }, [a, b], [], later), "decide", "no_last_writer");
    expectHome(homeOfSale({ ...base, marks: [...one, mark(102, "not_mine", { confirmed: true })] }, [a, b], [], later), "nobody", "marks");
  });

  it("no shift holding the sale goes to the look-in whose person last wrote, else nobody", () => {
    const look = visit(102, "2026-11-05 11:00", "2026-11-05 12:00");
    const one = sale("tip", "2026-11-05 11:30", 40_000, look);
    expectHome(homeOfSale({ ...one, lastWriter: 102 }, [look], [], later), "visit", "look_in_last_writer", whole100(look, 40_000));
    expectHome(homeOfSale({ ...one, lastWriter: 101 }, [look], [], later), "nobody", "no_holder");
    // A look-in beside a shift holding the sale takes nothing.
    const holder = shift(101, "2026-11-05 09:00", "2026-11-05 13:00");
    const both = { ...sale("tip", "2026-11-05 11:30", 40_000, holder, look), lastWriter: 102 };
    expectHome(homeOfSale(both, [holder, look], [], later), "shift", "holder", whole100(holder, 40_000));
  });

  it("a sale before 2 November is before the rule", () => {
    const holder = shift(101, "2026-11-01 11:00", "2026-11-01 16:30");
    const ppv = ppvBy(sale("ppv", "2026-11-01 16:00", 30_000, holder), 102, "chatter");
    expectHome(homeOfSale(ppv, [holder], [], later), "before_rule", "sale_before_rule");
    const tip = { ...sale("tip", "2026-11-01 23:59", 5_000), postTip: true };
    expectHome(homeOfSale(tip, [], [], later), "before_rule", "sale_before_rule");
  });

  it("the night shift of 1 November keeps the old rule past midnight", () => {
    // 19:00 1 Nov – 01:30 2 Nov: a shift of 1 November. Its sales after midnight stay the old rule's, a PPV too.
    const night = shift(101, "2026-11-01 19:00", "2026-11-02 01:30");
    const ppv = ppvBy(sale("ppv", "2026-11-02 00:20", 12_000, night), 102, "chatter");
    const sender = shift(102, "2026-11-02 10:00", "2026-11-02 18:00");
    expectHome(homeOfSale(ppv, [night, sender], [], later), "before_rule", "work_before_rule");
    // Beside a shift of 2 November whose person wrote last, the rule settles it.
    const morning = shift(103, "2026-11-02 00:00", "2026-11-02 08:00");
    const tip = { ...sale("tip", "2026-11-02 00:30", 8_000, night, morning), lastWriter: 103 };
    expectHome(homeOfSale(tip, [night, morning], [], later), "shift", "last_writer", whole100(morning, 8_000));
    expectHome(homeOfSale({ ...tip, lastWriter: null }, [night, morning], [], later), "before_rule", "work_before_rule");
  });

  it("the sender's shift of 1 November takes no PPV of the rule", () => {
    // The sender's night of 1 November is going at the purchase on page-a; the PPV on page-b waits for their next shift.
    const night = shift(102, "2026-11-01 19:00", "2026-11-02 01:30");
    const ppv = ppvBy(sale("ppv", "2026-11-02 00:20", 12_000), 102, "chatter");
    const next = shift(102, "2026-11-03 10:00", "2026-11-03 18:00");
    expectHome(homeOfSale(ppv, [night, next], [], later), "shift", "ppv_sender_next_shift", whole100(next, 12_000));
  });

  it("a holder missing from the works is unknown", () => {
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    expectHome(homeOfSale(sale("tip", "2026-11-05 14:00", 10_000, holder), [], [], later), "unknown", "holder_not_in_works");
  });
});

// ledger internal/accruals/claims.go and claims_test.go: the owner's claim of a nobody's sale.
describe("the owner's claim of a nobody's sale", () => {
  it("gives a nobody's sale to its claimer whole, on no work", () => {
    const one = { ...sale("tip", "2026-11-11 03:00", 50_000), claimedBy: 102 };
    expectHome(homeOfSale(one, [], [], later), "shift", "owner_claim", [{ workRef: null, userId: 102, percent: 100, mills: 50_000 }]);
    // A PPV whose sender had no shift in the wait can be claimed too.
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    const ppv = { ...ppvBy(sale("ppv", "2026-11-05 16:44", 8_000, holder), 102, "chatter"), claimedBy: 102 };
    expectHome(homeOfSale(ppv, [holder], [], later), "shift", "owner_claim", [{ workRef: null, userId: 102, percent: 100, mills: 8_000 }]);
  });

  it("stops applying when later facts find a holder: the claim moves no other home", () => {
    const holder = shift(101, "2026-11-11 01:00", "2026-11-11 09:00");
    const one = { ...sale("tip", "2026-11-11 03:00", 50_000, holder), claimedBy: 102 };
    expectHome(homeOfSale(one, [holder], [], later), "shift", "holder", whole100(holder, 50_000));
    // Nor does it settle a disputed sale, a waiting PPV or the pot.
    const a = shift(101, "2026-11-05 09:00", "2026-11-05 13:00");
    const b = shift(102, "2026-11-05 10:30", "2026-11-05 14:00");
    expectHome(homeOfSale({ ...sale("tip", "2026-11-05 11:00", 30_000, a, b), claimedBy: 103 }, [a, b], [], later), "decide", "no_last_writer");
    const waiting = { ...ppvBy(sale("ppv", "2026-11-05 16:44", 30_000), 102, "chatter"), claimedBy: 103 };
    expectHome(homeOfSale(waiting, [], [], msk("2026-11-06 12:00")), "waiting", "ppv_sender_waiting");
    expectHome(homeOfSale({ ...sale("tip", "2026-11-05 11:00", 30_000, a), postTip: true, claimedBy: 103 }, [a], [], later), "pot", "post_tip");
  });
});

// The owner's newer answers (Gengar's SKILL.md §4.2 and §4.4, 2026-11-12). Each beside Go's answer (LEDGER_GO_RULE).
describe("the owner's answers newer than ledger's Go", () => {
  it("a PPV of a sender who left the team is the shift's it was bought in", () => {
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    const left = msk("2026-11-04 12:00");
    const ppv = ppvBy(sale("ppv", "2026-11-05 14:00", 24_000, holder), 102, "chatter", left);
    expectHome(homeOfSale(ppv, [holder], [], later), "shift", "ppv_sender_left", whole100(holder, 24_000));
    // Go: the sender's PPV, no shift of theirs within the wait — nobody's.
    expectHome(homeOfSale(ppv, [holder], [], later, LEDGER_GO_RULE), "nobody", "ppv_sender_no_shift");
    // Within the wait it does not wait for a shift that will not come.
    expectHome(homeOfSale(ppv, [holder], [], msk("2026-11-06 12:00")), "shift", "ppv_sender_left", whole100(holder, 24_000));
    // Nobody held the page: nobody's, as any sale no shift held.
    expectHome(homeOfSale(ppvBy(sale("ppv", "2026-11-05 14:00", 24_000), 102, "chatter", left), [], [], later), "nobody", "no_holder");
  });

  it("a PPV of a sender who left later stays where their shifts took it before they left", () => {
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    const theirNext = shift(102, "2026-11-06 10:00", "2026-11-06 18:00");
    const ppv = ppvBy(sale("ppv", "2026-11-05 14:00", 24_000, holder), 102, "chatter", msk("2026-11-09 12:00"));
    expectHome(homeOfSale(ppv, [holder, theirNext], [], later), "shift", "ppv_sender_next_shift", whole100(theirNext, 24_000));
    // Not left yet at `now`: it waits as any chatter's.
    expectHome(homeOfSale(ppvBy(ppv, 102, "chatter", msk("2026-11-21 12:00")), [holder], [], msk("2026-11-06 12:00")), "waiting", "ppv_sender_waiting");
  });

  // The evening chatter (101): 18:00–02:00, but on page-a till 00:00; the night one (102): 00:00–08:00 everywhere.
  const slot = (personId: number, start: string, end: string, extra: Partial<RuleSlot> = {}): RuleSlot => {
    const minute = (at: string) => Number(at.slice(0, 2)) * 60 + Number(at.slice(3));
    return { personId, pageId: null, startMinute: minute(start), endMinute: minute(end), weekdays: null, validFrom: null, validTo: null, ...extra };
  };
  const slots = [slot(101, "18:00", "02:00"), slot(101, "18:00", "00:00", { pageId: PAGE_A }), slot(102, "00:00", "08:00")];

  it("at a junction no holder wrote to, the one holder whose slot runs takes a subscription or a tip", () => {
    // page-a after 00:00: the evening chatter stayed past their slot on it, the night one's runs.
    const evening = shift(101, "2026-11-11 18:00", "2026-11-12 02:10");
    const night = shift(102, "2026-11-11 23:55", "2026-11-12 08:00");
    const subscription = sale("subscription", "2026-11-12 01:46", 4_000, evening, night);
    const got = homeOfSale(subscription, [evening, night], slots, later);
    expectHome(got, "shift", "slot_owner", whole100(night, 4_000));
    expect(got.slotJunction).toBe(true);
    // Go knows no slots: it waits for the owner. So does this rule with no slots given.
    expectHome(homeOfSale(subscription, [evening, night], slots, later, LEDGER_GO_RULE), "decide", "no_last_writer");
    expectHome(homeOfSale(subscription, [evening, night], [], later), "decide", "no_last_writer");
    // A holder outside the slot who last wrote to the fan sold it personally; the one in the slot keeps hers.
    expectHome(homeOfSale({ ...subscription, lastWriter: 101 }, [evening, night], slots, later), "shift", "last_writer", whole100(evening, 4_000));
    expectHome(homeOfSale({ ...subscription, lastWriter: 102 }, [evening, night], slots, later), "shift", "last_writer", whole100(night, 4_000));
    // Someone else wrote last: still the slot's.
    expectHome(homeOfSale({ ...subscription, lastWriter: 103 }, [evening, night], slots, later), "shift", "slot_owner", whole100(night, 4_000));
    // On another page the evening slot runs till 02:00: both slots run, nobody of them wrote — the owner decides.
    const elsewhere = { ...subscription, pageId: 2 };
    expectHome(homeOfSale(elsewhere, [evening, night], slots, later), "decide", "no_last_writer");
    expectHome(homeOfSale({ ...elsewhere, lastWriter: 101 }, [evening, night], slots, later), "shift", "last_writer", whole100(evening, 4_000));
    // A slot not valid that day runs nowhere.
    const expired = [slots[0]!, slots[1]!, slot(102, "00:00", "08:00", { validTo: "2026-11-10" })];
    expectHome(homeOfSale(subscription, [evening, night], expired, later), "decide", "no_last_writer");
  });

  it("never lets the slot take a PPV from its sender, nor the pot; a left sender's PPV goes by the same steps", () => {
    const evening = shift(101, "2026-11-11 18:00", "2026-11-12 02:10");
    const night = shift(102, "2026-11-11 23:55", "2026-11-12 08:00");
    const ppv = ppvBy(sale("ppv", "2026-11-12 01:30", 8_000, evening, night), 101, "chatter");
    expectHome(homeOfSale(ppv, [evening, night], slots, later), "shift", "ppv_sender", whole100(evening, 8_000));
    const postTip = { ...sale("tip", "2026-11-12 01:30", 8_000, evening, night), postTip: true };
    expectHome(homeOfSale(postTip, [evening, night], slots, later), "pot", "post_tip");
    const ofLeft = ppvBy(sale("ppv", "2026-11-12 01:30", 8_000, evening, night), 103, "chatter", msk("2026-11-01 12:00"));
    expectHome(homeOfSale(ofLeft, [evening, night], slots, later), "shift", "ppv_sender_left", whole100(night, 8_000));
  });

  it("keeps the owner's split and the marks for a junction the slot does not settle", () => {
    const a = shift(101, "2026-11-05 09:00", "2026-11-05 13:00");
    const b = shift(102, "2026-11-05 10:30", "2026-11-05 14:00");
    const disputed = { ...sale("tip", "2026-11-05 11:00", 1_001, a, b), resolution: [{ userId: 101, percent: 100 }] };
    expectHome(homeOfSale(disputed, [a, b], [slot(101, "09:00", "17:00"), slot(102, "10:00", "18:00")], later), "shift", "owner_split", whole100(a, 1_001));
  });
});

// The people registry feeds the rule (ecosystem package C2): its schedule slots with their weekdays and validity, a
// person's slot for every login of theirs, and «left the team» from the person's state beside the login's end.
describe("the people registry's slots and leaving", () => {
  const minute = (at: string) => Number(at.slice(0, 2)) * 60 + Number(at.slice(3));
  const dateAt = (at: string) => new Date(msk(at));
  const slot = (personId: number, start: string, end: string, extra: Partial<RuleSlot> = {}): RuleSlot => ({
    personId, pageId: null, startMinute: minute(start), endMinute: minute(end), weekdays: null, validFrom: null, validTo: null, ...extra,
  });
  const runs = (slots: RuleSlot[], personId: number, at: string, pageId: number | null = PAGE_A) => slotRuns(slots, { personId, pageId, at: msk(at) });
  // 13 November 2026 is a Friday.
  const weekdaysOnly: RuleWeekday[] = ["mon", "tue", "wed", "thu", "fri"];

  it("runs a slot crossing midnight on the night after its last weekday, not the night after a day off", () => {
    expect(weekdayOfDay("2026-11-13")).toBe("fri");
    const evening = [slot(101, "18:00", "02:00", { weekdays: weekdaysOnly })];
    expect(runs(evening, 101, "2026-11-13 18:00")).toBe(true);
    // Saturday past midnight: Friday's slot still runs, to 02:00.
    expect(runs(evening, 101, "2026-11-14 01:59")).toBe(true);
    expect(runs(evening, 101, "2026-11-14 02:00")).toBe(false);
    // Saturday evening and the nights after Saturday and Sunday: no slot began.
    expect(runs(evening, 101, "2026-11-14 18:30")).toBe(false);
    expect(runs(evening, 101, "2026-11-15 01:00")).toBe(false);
    expect(runs(evening, 101, "2026-11-16 01:00")).toBe(false);
    expect(runs(evening, 101, "2026-11-16 18:00")).toBe(true);
    // No weekdays: every day.
    expect(runs([slot(101, "18:00", "02:00")], 101, "2026-11-15 01:00")).toBe(true);
  });

  it("settles a junction by the slot of the day it began", () => {
    const slots = [slot(101, "18:00", "02:00", { weekdays: weekdaysOnly }), slot(102, "00:00", "08:00")];
    // Friday's evening slot runs past midnight beside the night one: both run, nobody wrote — the owner decides.
    const friday = shift(101, "2026-11-13 18:00", "2026-11-14 02:10");
    const fridayNight = shift(102, "2026-11-13 23:55", "2026-11-14 08:00");
    const afterFriday = sale("subscription", "2026-11-14 01:00", 4_000, friday, fridayNight);
    expectHome(homeOfSale(afterFriday, [friday, fridayNight], slots, later), "decide", "no_last_writer");
    // The evening chatter worked Saturday too, outside her weekdays: past midnight only the night slot runs.
    const saturday = shift(101, "2026-11-14 18:00", "2026-11-15 02:10");
    const saturdayNight = shift(102, "2026-11-14 23:55", "2026-11-15 08:00");
    const afterSaturday = sale("subscription", "2026-11-15 01:00", 4_000, saturday, saturdayNight);
    expectHome(homeOfSale(afterSaturday, [saturday, saturdayNight], slots, later), "shift", "slot_owner", whole100(saturdayNight, 4_000));
  });

  it("lets a page's own line stand for the every-page one only on the days it is valid", () => {
    const slots = [slot(101, "18:00", "02:00"), slot(101, "18:00", "00:00", { pageId: PAGE_A, validTo: "2026-11-10" }),
      slot(101, "18:00", "23:00", { pageId: PAGE_A, validFrom: "2026-11-12" })];
    // The page's line began the 10th: its 00:00 end holds past midnight, though the 11th has no line of the page.
    expect(runs(slots, 101, "2026-11-11 01:00")).toBe(false);
    expect(runs(slots, 101, "2026-11-10 23:30")).toBe(true);
    // The 11th: no line of the page is valid, the every-page one runs there to 02:00.
    expect(runs(slots, 101, "2026-11-12 01:00")).toBe(true);
    // The 12th: the page's new line, to 23:00.
    expect(runs(slots, 101, "2026-11-12 23:30")).toBe(false);
    expect(runs(slots, 101, "2026-11-12 23:30", 2)).toBe(true);
    // A page's line valid that day stands for the every-page one on its days off too: off its weekdays nothing runs there.
    const weekdaysOnPage = [slot(101, "18:00", "02:00"), slot(101, "18:00", "00:00", { pageId: PAGE_A, weekdays: weekdaysOnly })];
    expect(runs(weekdaysOnPage, 101, "2026-11-14 19:00")).toBe(false);
    expect(runs(weekdaysOnPage, 101, "2026-11-14 19:00", 2)).toBe(true);
  });

  it("gives a person's slot to every login of theirs, and none to a person with no login", () => {
    const row = (id: number, personId: number, extra: Partial<PersonScheduleSlotRow> = {}): PersonScheduleSlotRow => ({
      id, personId, pageId: null, pageLabel: null, startMinute: 1080, endMinute: 0, weekdays: null, validFrom: null, validTo: null, ...extra,
    });
    const slots = [
      row(1, 7, { weekdays: ["mon", "sat"] }),
      row(2, 7, { pageId: PAGE_A, pageLabel: "page-a", endMinute: 1440 }),
      row(3, 8),
      // Ended before the days asked about.
      row(4, 9, { validTo: "2026-11-01" }),
      row(5, 9, { validFrom: "2026-11-02" }),
    ];
    const logins = [{ personId: 7, userId: 101 }, { personId: 7, userId: 111 }, { personId: 9, userId: 103 }];
    const got = ruleSlotsOf({ slots, logins, from: dateAt("2026-11-09 00:00"), to: dateAt("2026-11-12 00:00") });
    expect(got).toEqual([
      { personId: 101, pageId: null, startMinute: 1080, endMinute: 0, weekdays: ["mon", "sat"], validFrom: null, validTo: null },
      { personId: 111, pageId: null, startMinute: 1080, endMinute: 0, weekdays: ["mon", "sat"], validFrom: null, validTo: null },
      { personId: 101, pageId: PAGE_A, startMinute: 1080, endMinute: 1440, weekdays: null, validFrom: null, validTo: null },
      { personId: 111, pageId: PAGE_A, startMinute: 1080, endMinute: 1440, weekdays: null, validFrom: null, validTo: null },
      { personId: 103, pageId: null, startMinute: 1080, endMinute: 0, weekdays: null, validFrom: "2026-11-02", validTo: null },
    ]);
    // A slot ending 24:00 runs to midnight.
    expect(slotRuns(got, { personId: 111, pageId: PAGE_A, at: msk("2026-11-10 23:59") })).toBe(true);
    expect(slotRuns(got, { personId: 111, pageId: PAGE_A, at: msk("2026-11-11 00:00") })).toBe(false);
  });

  it("dates a sender's leaving by the first of the login's end and the person's leaving", () => {
    const none = { disabledAt: null, deletedAt: null, personLeft: null };
    expect(leftAtOf(none)).toBeNull();
    // A login with no person: its own end, as before the registry.
    expect(leftAtOf({ ...none, disabledAt: dateAt("2026-11-06 12:00"), deletedAt: dateAt("2026-11-08 12:00") })).toBe(msk("2026-11-06 12:00"));
    // The person left on a known day: from its Moscow midnight, the login still alive.
    expect(leftAtOf({ ...none, personLeft: { leftOn: "2026-11-04", recordedAt: dateAt("2026-11-12 11:51") } })).toBe(msk("2026-11-04 00:00"));
    // The day unknown: from when the registry came to say so.
    expect(leftAtOf({ ...none, personLeft: { leftOn: null, recordedAt: dateAt("2026-11-12 11:51") } })).toBe(msk("2026-11-12 11:51"));
    // Both: the first.
    expect(leftAtOf({ ...none, deletedAt: dateAt("2026-11-03 09:00"), personLeft: { leftOn: "2026-11-04", recordedAt: dateAt("2026-11-12 11:51") } }))
      .toBe(msk("2026-11-03 09:00"));
    // The rule reads it: the PPV of a sender whose person left goes by the shift it was bought in.
    const holder = shift(101, "2026-11-05 13:00", "2026-11-05 20:00");
    const leftAt = leftAtOf({ ...none, personLeft: { leftOn: "2026-11-04", recordedAt: dateAt("2026-11-12 11:51") } });
    expectHome(homeOfSale(ppvBy(sale("ppv", "2026-11-05 14:00", 24_000, holder), 102, "chatter", leftAt), [holder], [], later),
      "shift", "ppv_sender_left", whole100(holder, 24_000));
  });

  it("reads a slots file written before weekdays as every day", () => {
    expect(slotsOfFile([{ personId: 101, pageId: null, startMinute: 960, endMinute: 0, validFrom: null, validTo: null }]))
      .toEqual([{ personId: 101, pageId: null, startMinute: 960, endMinute: 0, weekdays: null, validFrom: null, validTo: null }]);
    expect(() => slotsOfFile([{ personId: 101, startMinute: 960, endMinute: 0, weekdays: ["fri", "funday"] }])).toThrow(/weekdays/);
  });
});

// The comparison's range (sale-rule-compare.ts): a work is whole in the day of its middle, as Workboard counts it.
describe("the comparison's range edge", () => {
  const iso = (at: string) => new Date(msk(at)).toISOString();
  const work = (user: number, from: string, to: string): AgentTeamWork => ({
    ref: `${user}:${iso(from)}`, userId: user, username: `chatter-${user}`, role: "chatter", kind: "shift", startedAt: iso(from),
    endedAt: iso(to), ongoing: false, workedMinutes: 300, pages: [{ pageLabel: "page-a", messages: 40, salesFrom: iso(from) }],
  });
  const teamSale = (ref: string, at: string, net: number, ...holders: AgentTeamWork[]): AgentTeamSale => ({
    transactionRef: ref, pageLabel: "page-a", platform: "onlyfans", fanRef: "fan-1", kind: "tip", netMills: net, occurredAt: iso(at),
    holders: holders.map((one) => one.ref), ppvSender: null, ppvSentAt: null, ppvWithoutAuthor: false, postTip: false, campaign: false,
    lastWriterUserId: null, writers: [], marks: [], resolution: null,
  });
  const factRow = (ref: string, at: string, net: number, user: number, holder: AgentTeamWork, day: string): LedgerFactHome => ({
    ref, seq: 0, window: "w", at: iso(at), page: "page-a", kind: "tip", netMicros: net * 1000, home: "shift", reason: "holder",
    userId: user, username: `chatter-${user}`, person: null, workRef: holder.ref, shareMicros: net * 1000, day,
  });

  it("counts an evening shift's sales past the last midnight in its day, and leaves the next day's shifts out", () => {
    const evening = work(101, "2026-11-11 18:00", "2026-11-12 02:00");
    const nextMorning = work(102, "2026-11-12 09:00", "2026-11-12 15:00");
    const sales = [
      teamSale("1", "2026-11-11 20:00", 300_000, evening),
      teamSale("2", "2026-11-12 01:00", 430_000, evening),
      teamSale("3", "2026-11-12 10:00", 50_000, nextMorning),
    ];
    const answer: AgentTeamSalesResponse = {
      from: iso("2026-11-10 00:00"), to: iso("2026-11-13 00:00"), workFrom: iso("2026-11-02 00:00"), workTo: iso("2026-11-12 18:00"),
      pages: ["page-a"], works: [evening, nextMorning], sales, serverNow: iso("2026-11-12 18:00"),
    };
    const ledger: LedgerExport = {
      windows: [], works: new Map(), sales: new Map(), pages: ["page-a"], claims: [], layouts: [], layoutLines: [], posted: [],
      homes: [
        factRow("1", "2026-11-11 20:00", 300_000, 101, evening, "2026-11-11"),
        factRow("2", "2026-11-12 01:00", 430_000, 101, evening, "2026-11-11"),
        factRow("3", "2026-11-12 10:00", 50_000, 102, nextMorning, "2026-11-12"),
      ],
    };
    const report = compareSaleRule({
      first: "2026-11-11", last: "2026-11-11", hubNow: new Date(msk("2026-11-12 18:00")), hub: [{ window: null, answer }], ledger,
      leftAt: new Map(), pageIds: new Map([["page-a", PAGE_A]]), slots: [], slotsSource: "none", platformRefOf: new Map(),
      workboard: [{ userId: 101, username: "chatter-101", daily: [{ date: "2026-11-11", salesNetMills: 730_000 }] }],
    });
    expect(report.sales.map((one) => one.ref)).toEqual(["1", "2"]);
    expect(report.sales.every((one) => one.same)).toBe(true);
    expect(report.days.map(({ person, day, workboardMills, ruleMills, factsMills }) => ({ person, day, workboardMills, ruleMills, factsMills })))
      .toEqual([{ person: "chatter-101", day: "2026-11-11", workboardMills: 730_000, ruleMills: 730_000, factsMills: 730_000 }]);
  });
});
