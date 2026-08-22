import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalizeFanslyPayoutsObservation,
  canParseFanslyPayoutsObservation,
  decodePayoutMethodMetadata,
  FANSLY_PAYOUT_METADATA_UNPARSED_DIAGNOSTIC,
  FANSLY_PAYOUTS_CANONICALIZED_KINDS,
  FANSLY_PAYOUTS_EVENT_TYPES,
  maskPayoutEmail,
  maskPayoutWalletField,
  PAYOUT_PROVIDER_LABELS,
  PAYOUT_STATUS_LABELS,
  payoutStatus,
} from "../apps/runtime/src/services/canonicalize/fansly-payouts.ts";
import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import { WRITTEN_OBSERVATION_KINDS } from "../apps/runtime/src/services/observation-kinds.ts";
import type {
  CanonicalEventDraft,
  CanonicalizableObservation,
} from "../apps/runtime/src/services/canonicalize/types.ts";

// WP-F7 — the `fansly-payouts` family, fixture by fixture.
//
// THE FOUR THINGS THIS FILE GUARDS, because each is a way the family can be
// wrong that `pnpm check` would otherwise call fine:
//
// 1. THE CREDENTIAL. `/payments/payoutmethods` returns the creator's FULL email
//    for provider 2. Exactly one thing derived from that field may leave this
//    family, and it is a mask this repository owns. The adversarial cases below
//    are the point of the file, not an appendix to it.
// 2. THE UNKNOWN PROVIDER. The decode is PROVIDER-KEYED, so a provider nobody
//    has met decodes to nothing at all — not to "field1, masked", which is what
//    a shape-keyed decoder would publish.
// 3. THE STATUS. One code deep. `8` is `Processed` and every other integer is
//    `unmapped:<code>`, because a failed payout reported as completed is money
//    the agency believes arrived.
// 4. THE MONEY AND THE TIME. Mills with no scaling, and receipt-time events —
//    the walked history reaches into 2025 and `domain_events` is
//    monthly-partitioned, so a provider-dated draft would be unwritable.

const FIXTURES = path.resolve("tests/fixtures/fansly-payouts");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

/** The method fixtures store their BARE ARRAY under `rows` so the file can also
 *  carry its `_fixture` provenance note; the wire shape is the array itself. */
function methodRows(name: string): unknown {
  return fixture(name).rows;
}

const RECEIVED_AT = new Date("2026-08-22T09:00:00.000Z");

function observation(
  kind: string,
  payload: unknown,
  overrides: Partial<CanonicalizableObservation> = {},
): CanonicalizableObservation {
  return {
    id: 1,
    source: "pull",
    producer: "sync",
    platform: "fansly",
    accountId: 7,
    kind,
    payload,
    observedAt: null,
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

function drafts(
  kind: string,
  payload: unknown,
  diagnostics?: string[],
  overrides: Partial<CanonicalizableObservation> = {},
): CanonicalEventDraft[] {
  return canonicalizeFanslyPayoutsObservation(observation(kind, payload, overrides), {
    nativeAccountRefByAccountId: new Map(),
    ...(diagnostics === undefined
      ? {}
      : { diagnostics: { record: (code: string) => void diagnostics.push(code) } }),
  });
}

function ofType(list: readonly CanonicalEventDraft[], type: string): CanonicalEventDraft[] {
  return list.filter((draft) => draft.type === type);
}

function byRef(
  list: readonly CanonicalEventDraft[],
  type: string,
  refKey: string,
  ref: string,
): CanonicalEventDraft {
  const found = ofType(list, type).find((draft) => draft.data[refKey] === ref);
  expect(found, `${type} ${ref}`).toBeDefined();
  return found!;
}

/** Every string anywhere in a value, so a credential cannot hide in a nested
 *  array or an object this family did not expect to serve. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) allStrings(item, out);
  }
  return out;
}

describe("fansly-payouts family registration", () => {
  it("claims both kinds, emits only registered types, and is projection-only", () => {
    const family = CANONICALIZER_FAMILIES.find((entry) => entry.lane === "payouts");
    expect(family).toBeDefined();
    expect(family?.projectionOnly).toBe(true);
    expect(family?.source).toBe("pull");
    expect([...(family?.kinds ?? [])].sort())
      .toEqual([...FANSLY_PAYOUTS_CANONICALIZED_KINDS].sort());

    // Both kinds are in the coverage registry, so the BL-C3 class of mistake —
    // a journaled kind nothing ever claims — fails at the PR that makes it.
    const registered = new Set(WRITTEN_OBSERVATION_KINDS.map((entry) => entry.kind));
    for (const kind of FANSLY_PAYOUTS_CANONICALIZED_KINDS) {
      expect(registered.has(kind), kind).toBe(true);
    }
  });

  it("emits nothing outside its declared event types", () => {
    const declared = new Set<string>(FANSLY_PAYOUTS_EVENT_TYPES);
    const produced = [
      ...drafts("payout_methods", methodRows("payout-methods")),
      ...drafts("payout_requests", fixture("payout-requests-page").page),
    ];
    expect(produced.length).toBeGreaterThan(0);
    for (const draft of produced) {
      expect(declared.has(draft.type), draft.type).toBe(true);
    }
  });
});

describe("the credential rule", () => {
  it("masks provider 2's PLAINTEXT email to `<first char>***@<domain>`", () => {
    const list = drafts("payout_methods", methodRows("payout-methods"));
    const paxum = byRef(list, "payout.method_observed", "methodRef", "000900000000009001");

    // THE PINNED MASK. One character of the local part, three asterisks, the
    // domain. A fixed three rather than one-per-character, because a
    // length-preserving mask leaks the length.
    expect(paxum.data.maskedLabel).toBe("f***@example.invalid");
    expect(paxum.data.providerId).toBe(2);
    // PAXUM, NOT PAYPAL (A22-4). The API spec says PayPal and is wrong; the app
    // bundle renders provider 2 with `paxum.webp`.
    expect(paxum.data.providerLabel).toBe("paxum");
    expect(PAYOUT_PROVIDER_LABELS.get(2)).toBe("paxum");
    expect(paxum.data.metadataParseOk).toBe(true);
  });

  it("keeps provider 30's ALREADY-MASKED wallet field to its four visible characters", () => {
    const list = drafts("payout_methods", methodRows("payout-methods"));
    const usdt = byRef(list, "payout.method_observed", "methodRef", "000900000000009002");
    expect(usdt.data.maskedLabel).toBe("****1a2b");
    expect(usdt.data.providerId).toBe(30);
    expect(usdt.data.providerLabel).toBe("usdt");
    // NOTHING ELSE from the field set. `field0` (the coin), `field2` (the
    // chain) and the eight empty fields are decoded and thrown away — the wire
    // shape has eleven fields and exactly one four-character suffix survives.
    const emitted = allStrings(usdt.data).join("|");
    expect(emitted).not.toContain("TRC20");
    expect(emitted).not.toContain("USDT");
    expect(emitted).not.toContain("XXXX");
  });

  it("NO EVENT CARRIES A FULL ADDRESS, anywhere in its tree", () => {
    const list = drafts("payout_methods", methodRows("payout-methods"));
    for (const draft of list) {
      for (const value of allStrings(draft.data)) {
        // A masked label is `f***@example.invalid`; a real address is not.
        expect(value, `${draft.type} leaked an address`)
          .not.toMatch(/[\w.+-]{2,}@[\w.-]+\.[a-z]{2,}/iu);
      }
    }
    // And the CAPTURE side still has it verbatim — capture-first (DP 7). The
    // mask is a projection rule, never a capture rule: an over-eager scrubber
    // at the journal would have destroyed the only copy of the fact.
    const raw = JSON.stringify(methodRows("payout-methods"));
    expect(raw).toContain("fixture.creator@example.invalid");
  });

  it("decodes NOTHING for a provider it does not know by number", () => {
    // THE ADVERSARIAL CASE THIS FAMILY IS SHAPED AROUND. Provider 99 does not
    // exist today. Its payload happens to look exactly like provider 30's —
    // `field0…field4` — so a SHAPE-keyed decoder would have masked `field1` and
    // published the four characters it chose to end with, and would have had no
    // opinion at all about `field3`.
    const list = drafts("payout_methods", methodRows("payout-methods-adversarial"));
    const future = byRef(list, "payout.method_observed", "methodRef", "000900000000009101");
    expect(future.data.maskedLabel).toBeNull();
    expect(future.data.providerId).toBe(99);
    expect(future.data.providerLabel).toBe("unmapped:99");
    // Not one character of the metadata reaches the event.
    const emitted = allStrings(future.data).join("|");
    expect(emitted).not.toContain("FUTURECOIN");
    expect(emitted).not.toContain("0xFIXTUREWALLET");
    expect(emitted).not.toContain("RECOVERY");
    expect(emitted).not.toContain("cafebabe");
    expect(emitted).not.toContain("babe99");
  });

  it("records an UNPARSED metadata string as a fact rather than swallowing it", () => {
    const diagnostics: string[] = [];
    const list = drafts(
      "payout_methods",
      methodRows("payout-methods-adversarial"),
      diagnostics,
    );
    const broken = byRef(list, "payout.method_observed", "methodRef", "000900000000009102");
    // The ROW still exists — a method we could not read and a method with
    // nothing to read are different facts, and `metadataParseOk` is what tells
    // them apart.
    expect(broken.data.metadataParseOk).toBe(false);
    expect(broken.data.maskedLabel).toBeNull();
    expect(diagnostics).toContain(FANSLY_PAYOUT_METADATA_UNPARSED_DIAGNOSTIC);
    // The unreadable string stays in the JOURNAL and nowhere else.
    expect(allStrings(broken.data).join("|")).not.toContain("unterminated");
  });

  it("masks a one-character local part without collapsing to nothing", () => {
    const list = drafts("payout_methods", methodRows("payout-methods-adversarial"));
    const short = byRef(list, "payout.method_observed", "methodRef", "000900000000009103");
    expect(short.data.maskedLabel).toBe("a***@example.invalid");
  });

  it("refuses to half-mask a value that is not an address or a wallet field", () => {
    // Half a mask is worse than an honest absence: it looks like a value.
    expect(maskPayoutEmail("@example.invalid")).toBeNull();
    expect(maskPayoutEmail("nobody@")).toBeNull();
    expect(maskPayoutEmail("nobody")).toBeNull();
    expect(maskPayoutEmail(null)).toBeNull();
    expect(maskPayoutWalletField("abc")).toBeNull();
    expect(maskPayoutWalletField(null)).toBeNull();
    // A subdomained address keeps the WHOLE domain — the operator needs to know
    // which processor account this is, and only the local part identifies a
    // person.
    expect(maskPayoutEmail("first.last@mail.example.invalid"))
      .toBe("f***@mail.example.invalid");
    // Only the LAST `@` splits, so an address with an `@` in the local part
    // cannot smuggle the rest of itself into the "domain".
    expect(maskPayoutEmail("a@b@example.invalid")).toBe("a***@example.invalid");
  });

  it("decodes an object-shaped metadata too, in case the platform stops encoding it", () => {
    // The platform serves a STRING today. If it ever serves the object
    // directly, the mask must still be applied rather than the whole object
    // sailing through as "not a string, nothing to do".
    expect(decodePayoutMethodMetadata({ email: "someone@example.invalid" }, 2))
      .toEqual({ parseOk: true, maskedLabel: "s***@example.invalid" });
    // And an ABSENT metadata is not a parse failure.
    expect(decodePayoutMethodMetadata(null, 2)).toEqual({ parseOk: true, maskedLabel: null });
    expect(decodePayoutMethodMetadata("", 2)).toEqual({ parseOk: true, maskedLabel: null });
  });
});

describe("the status map", () => {
  it("is ONE code deep and says so", () => {
    expect([...PAYOUT_STATUS_LABELS.entries()]).toEqual([[8, "Processed"]]);
  });

  it("maps 8 and refuses to name anything else", () => {
    expect(payoutStatus(8)).toEqual({
      statusCode: 8,
      statusLabel: "Processed",
      statusConfidence: "mapped",
    });
    for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 9, 16013]) {
      expect(payoutStatus(code)).toEqual({
        statusCode: code,
        statusLabel: `unmapped:${code}`,
        statusConfidence: "unmapped",
      });
    }
    // A missing or non-integer status is not code 0.
    expect(payoutStatus(undefined).statusCode).toBeNull();
    expect(payoutStatus("8").statusCode).toBeNull();
  });

  it("projects the integer and the label TOGETHER on every row", () => {
    const list = drafts("payout_requests", fixture("payout-requests-page").page);
    const processed = byRef(list, "payout.observed", "payoutRef", "000900000000008001");
    expect(processed.data.statusCode).toBe(8);
    expect(processed.data.statusLabel).toBe("Processed");
    expect(processed.data.statusConfidence).toBe("mapped");

    const unknown = byRef(list, "payout.observed", "payoutRef", "000900000000008002");
    expect(unknown.data.statusCode).toBe(4);
    expect(unknown.data.statusLabel).toBe("unmapped:4");
    expect(unknown.data.statusConfidence).toBe("unmapped");
    // The ROW IS STILL EMITTED. Dropping the codes we cannot name would make
    // the history quietly agree with itself and disagree with the platform.
    expect(unknown.data.amountMills).toBe("2102632");
  });
});

describe("money and time", () => {
  it("round-trips mills EXACTLY, with no scaling anywhere", () => {
    const list = drafts("payout_requests", fixture("payout-requests-page").page);
    // $131 on screen arrived as 131 000 on the wire, and 131 000 is what the
    // kernel stores. The wire unit IS the kernel unit — there is no ÷10, no
    // ×100, no cents anywhere on this route.
    expect(byRef(list, "payout.observed", "payoutRef", "000900000000008001").data.amountMills)
      .toBe("131000");
    expect(byRef(list, "payout.observed", "payoutRef", "000900000000008002").data.amountMills)
      .toBe("2102632");
    expect(byRef(list, "payout.observed", "payoutRef", "000900000000008003").data.amountMills)
      .toBe("1600");
  });

  it("refuses a negative or fractional amount rather than rounding it", () => {
    const list = drafts("payout_requests", {
      total: 2,
      data: [
        { id: "000900000000008801", amount: -500, status: 8, createdAt: 1785692041000 },
        { id: "000900000000008802", amount: 12.5, status: 8, createdAt: 1785692041000 },
      ],
    });
    for (const draft of ofType(list, "payout.observed")) {
      // A plausible-looking rounded number is worse than an honest null: it is
      // money that can be summed.
      expect(draft.data.amountMills).toBeNull();
    }
  });

  it("decodes both instants as MILLISECONDS and leaves a missing one null", () => {
    const list = drafts("payout_requests", fixture("payout-requests-page").page);
    const row = byRef(list, "payout.observed", "payoutRef", "000900000000008001");
    expect(row.data.createdAtPlatform).toBe(new Date(1785692041000).toISOString());
    expect(row.data.updatedAtPlatform).toBe(new Date(1785778441000).toISOString());

    const missing = drafts("payout_requests", {
      total: 1,
      data: [{ id: "000900000000008901", amount: 0, status: 8 }],
    });
    const only = ofType(missing, "payout.observed")[0]!;
    // NOT 1970. A missing timestamp that becomes the epoch is a row that sorts
    // to the bottom of the history forever.
    expect(only.data.createdAtPlatform).toBeNull();
    expect(only.data.updatedAtPlatform).toBeNull();
  });

  it("dates every event at RECEIPT and never clamps a pre-2024 payout (§3.2b)", () => {
    const list = drafts("payout_requests", fixture("payout-requests-page").page);
    const old = byRef(list, "payout.observed", "payoutRef", "000900000000008003");
    // The provider instant is 2023 and it is preserved — in `data`, typed.
    expect(String(old.data.createdAtPlatform).startsWith("2023-")).toBe(true);
    // The EVENT is dated when we looked, which is what keeps it writable: the
    // ledger is monthly-partitioned and a 2023-dated draft would fail
    // ExecFindPartition (23514) forever.
    for (const draft of list) {
      expect(draft.occurredAt).toEqual(RECEIVED_AT);
      // A receipt-time draft is inside the clamp window by construction, so no
      // event from this family may ever carry the clamp marker.
      expect(draft.data.occurredAtClamped).toBeUndefined();
      expect(draft.data.occurredAtRaw).toBeUndefined();
    }
  });
});

describe("revisions and the roster", () => {
  it("re-observing identical bytes appends nothing; a status change is a revision", () => {
    const page = fixture("payout-requests-page").page as { total: number; data: unknown[] };
    const first = drafts("payout_requests", page);
    const again = drafts("payout_requests", page);
    expect(again.map((draft) => draft.dedupKey)).toEqual(first.map((draft) => draft.dedupKey));

    const rows = page.data as Record<string, unknown>[];
    const moved = {
      total: page.total,
      data: [{ ...rows[0], status: 4, version: 3 }, ...rows.slice(1)],
    };
    const revised = drafts("payout_requests", moved);
    const before = byRef(first, "payout.observed", "payoutRef", "000900000000008001");
    const after = byRef(revised, "payout.observed", "payoutRef", "000900000000008001");
    // A NEW event, not an in-place edit: the head moves because the ledger
    // grew, which is the only way a projection rebuild can reproduce it.
    expect(after.dedupKey).not.toBe(before.dedupKey);
    expect(after.data.statusLabel).toBe("unmapped:4");
  });

  it("emits ONE roster per look, carrying every method ref, sorted", () => {
    const list = drafts("payout_methods", methodRows("payout-methods"));
    const rosters = ofType(list, "payout.method_list_observed");
    expect(rosters).toHaveLength(1);
    expect(rosters[0]!.data.refs).toEqual([
      "000900000000009001",
      "000900000000009002",
    ]);
    expect(rosters[0]!.data.count).toBe(2);
    // The roster is the LAST draft, after every row it describes — the
    // projector marks the complement only once the survivors have been upserted.
    expect(list[list.length - 1]!.type).toBe("payout.method_list_observed");
  });

  it("keys the roster per LOOK, so a method that returns UNCHANGED is un-marked", () => {
    // The WP-F3 correction, re-pinned here because this family inherited it. A
    // method removed and re-added unchanged produces a ref set identical to the
    // one before it vanished. Keying on the SET would dedupe the event, the
    // projector would never see it, and the row would stay marked
    // `missing_since` forever while the platform served it again.
    const a = drafts("payout_methods", methodRows("payout-methods"), undefined, { id: 11 });
    const b = drafts("payout_methods", methodRows("payout-methods"), undefined, { id: 12 });
    const rosterA = ofType(a, "payout.method_list_observed")[0]!;
    const rosterB = ofType(b, "payout.method_list_observed")[0]!;
    expect(rosterA.dedupKey).not.toBe(rosterB.dedupKey);
    // The row events still dedupe across looks — only the roster is per-look.
    expect(ofType(a, "payout.method_observed").map((draft) => draft.dedupKey))
      .toEqual(ofType(b, "payout.method_observed").map((draft) => draft.dedupKey));
  });

  it("emits a roster for an EMPTY listing, which is the case it exists for", () => {
    const list = drafts("payout_methods", methodRows("payout-methods-empty"));
    expect(ofType(list, "payout.method_observed")).toHaveLength(0);
    const rosters = ofType(list, "payout.method_list_observed");
    expect(rosters).toHaveLength(1);
    expect(rosters[0]!.data.refs).toEqual([]);
    // Zero ROW events and one roster: without the roster, a creator who removed
    // every payout method would leave the old rows reading as live forever.
    expect(rosters[0]!.data.count).toBe(0);
  });

  it("gives payout REQUESTS no roster — an offset page is not a listing", () => {
    const list = drafts("payout_requests", fixture("payout-requests-page").page);
    expect(ofType(list, "payout.method_list_observed")).toHaveLength(0);
    // A roster built from one page of ten would mark the other seventy-three
    // missing, and the next page would un-mark them.
    expect(new Set(list.map((draft) => draft.type))).toEqual(new Set(["payout.observed"]));
  });
});

describe("the shape gate", () => {
  it("accepts both live shapes and the empty listing", () => {
    expect(canParseFanslyPayoutsObservation({
      kind: "payout_methods",
      payload: methodRows("payout-methods"),
      accountId: 7,
    })).toBe(true);
    expect(canParseFanslyPayoutsObservation({
      kind: "payout_methods",
      payload: [],
      accountId: 7,
    })).toBe(true);
    expect(canParseFanslyPayoutsObservation({
      kind: "payout_requests",
      payload: { total: 0, data: [] },
      accountId: 7,
    })).toBe(true);
  });

  it("REFUSES a drifted body, leaving it unstamped for a later parser", () => {
    // The load-bearing negative. A `payout_requests` body with no `data` array
    // is drift, not an empty history — and the difference decides the WALK,
    // which stops when a page comes back short. Consuming it with zero events
    // would record the history as exhausted at that offset and never look again.
    expect(canParseFanslyPayoutsObservation({
      kind: "payout_requests",
      payload: { total: 83 },
      accountId: 7,
    })).toBe(false);
    expect(canParseFanslyPayoutsObservation({
      kind: "payout_requests",
      payload: { __empty: true, httpStatus: 204 },
      accountId: 7,
    })).toBe(false);
    expect(canParseFanslyPayoutsObservation({
      kind: "payout_methods",
      payload: "not json at all",
      accountId: 7,
    })).toBe(false);
    // No page mapping, no events: the rows would be unattributable.
    expect(canParseFanslyPayoutsObservation({
      kind: "payout_methods",
      payload: [],
      accountId: null,
    })).toBe(false);
    // And a kind this family does not claim is never its business.
    expect(canParseFanslyPayoutsObservation({
      kind: "earnings_transactions",
      payload: [],
      accountId: 7,
    })).toBe(false);
  });

  it("skips a row with no id rather than minting an unaddressable head", () => {
    const list = drafts("payout_methods", [{ providerId: "2", metadata: "{}" }]);
    expect(ofType(list, "payout.method_observed")).toHaveLength(0);
    expect(ofType(list, "payout.method_list_observed")[0]!.data.refs).toEqual([]);
  });
});
