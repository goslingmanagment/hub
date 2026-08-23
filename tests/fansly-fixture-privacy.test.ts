import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const FIXTURE_DIRECTORY = path.resolve("tests/fixtures/fansly");
const STATS_FIXTURE_DIRECTORY = path.resolve("tests/fixtures/fansly-stats");
const LEGACY_RESPONSE_DIRECTORY = path.resolve("reference/responses");
const EXPECTED_FIXTURES = [
  "account_me.json",
  "followers.json",
  "group_detail.json",
  "message.json",
  "messaging_groups.json",
  // WP-F0(a-1): the VERBATIM-shaped conversation-list fixture. The trimmed
  // `messaging_groups.json` above cannot serve the [A18] byte-identity pin —
  // it is already trimmed-shaped, so the assertion would pass vacuously.
  "messaging_groups_verbatim.json",
  "subscribers.json",
];
/**
 * WP-F1 statistics fixtures (`tests/fixtures/fansly-stats/`).
 *
 * They live in their own directory with their own rule, and the rule is
 * STRUCTURAL rather than an enumeration: every 15+ digit identifier must be
 * `0009` followed by fourteen digits. A real Fansly snowflake never starts with
 * a zero, so the SHAPE proves the id is fabricated — which is stronger than a
 * list, because a list can be extended by the same hand that pastes a live
 * payload, and this one cannot be satisfied by one.
 *
 * Money values are deliberately NOT enumerated here, and that is a decision
 * rather than an omission: a statistics fixture is dozens of aggregate counters
 * that carry no identity, an enumeration of them would be maintenance theatre
 * that gets rubber-stamped, and the risk this file exists for — identities,
 * credentials, signed URLs — is caught by the checks that DO apply below.
 */
const STATS_SYNTHETIC_ID_PATTERN = /^0009\d{14}$/u;
const STATS_FIXTURE_MAX_BYTES = 16_384;
/**
 * WP-F2 engagement fixtures (`tests/fixtures/fansly-engagement/`) — the SAME
 * structural rule, with a larger ceiling and a reason for it.
 *
 * The census fixture carries all 200 rows of the §2.3 census (3003×97, 2007×30,
 * 15016×26, 7001×26, 15007×15, 2008×6), because a census pin that samples the
 * census is not a census pin. A real four-page notifications capture is ~252 KB
 * decoded, so a ceiling of 96 KB still refuses a pasted one while leaving room
 * for 200 fabricated rows.
 */
const ENGAGEMENT_FIXTURE_DIRECTORY = path.resolve("tests/fixtures/fansly-engagement");
const ENGAGEMENT_FIXTURE_MAX_BYTES = 98_304;
/**
 * WP-F3 catalog fixtures (`tests/fixtures/fansly-catalog/`) — the SAME
 * structural rule, at the statistics ceiling.
 *
 * A real `/vault/albumsnew` response is ~183 KB decoded (27 albums plus a
 * 25-row raw-media sidecar full of signed CDN URLs), and a real
 * `/subscriptions/giftcodes` is ~27 KB. A 16 KB ceiling therefore refuses a
 * pasted capture of either while leaving room for the handful of fabricated
 * rows each shape needs to be pinned — including the system albums that make
 * the double-count visible.
 */
const CATALOG_FIXTURE_DIRECTORY = path.resolve("tests/fixtures/fansly-catalog");
const CATALOG_FIXTURE_MAX_BYTES = 16_384;
/**
 * WP-F5 comment fixtures (`tests/fixtures/fansly-comments/`) — the SAME
 * structural rule, at a TIGHTER ceiling than the others.
 *
 * The largest live `/post/{id}/replies` response is 18.2 KB decoded: four
 * replies plus four FULL account records with avatars, notes and subscription
 * histories. An 8 KB ceiling therefore refuses a pasted capture of even the
 * biggest one observed, while leaving room for the fabricated four-reply parity
 * fixture — which is the point: this directory holds the fan's own WORDS, and
 * it is the one corpus where a paste is both easiest and worst.
 */
const COMMENTS_FIXTURE_DIRECTORY = path.resolve("tests/fixtures/fansly-comments");
const COMMENTS_FIXTURE_MAX_BYTES = 8_192;
/**
 * WP-F7 payout fixtures (`tests/fixtures/fansly-payouts/`) — the same
 * structural rule with ONE deliberate relaxation, and the relaxation is the
 * reason the directory exists.
 *
 * Every other corpus here forbids an `@` outright. This one cannot: the whole
 * point of the payout-method fixtures is that provider 2 returns a PLAINTEXT
 * EMAIL, and a mask fixture with nothing to mask proves nothing. So the ban on
 * `@` is replaced by something STRICTER rather than weaker — every
 * address-shaped substring must sit on `example.invalid`, the RFC 6761
 * reserved domain that can never resolve. A pasted live address fails, because
 * no real payout method is registered on a domain that does not exist.
 *
 * The ceiling is small on purpose: a real `/payments/payoutmethods` response is
 * two rows and a real request page is ten, so there is no volume here that
 * could justify a paste.
 */
const PAYOUTS_FIXTURE_DIRECTORY = path.resolve("tests/fixtures/fansly-payouts");
const PAYOUTS_FIXTURE_MAX_BYTES = 8_192;
const PAYOUTS_SYNTHETIC_EMAIL_DOMAIN = "example.invalid";

const SYNTHETIC_SNOWFLAKES = new Set(["863308077229670400"]);
const SYNTHETIC_IDENTIFIERS = new Set([
  ...SYNTHETIC_SNOWFLAKES,
  "acct_creator",
  "acct_fan_alpha",
  // The second conversation of the verbatim fixture: one row is not enough to
  // prove an identity rewrite over an ARRAY.
  "acct_fan_beta",
  "group_alpha",
  "group_beta",
  "history_alpha",
  "like_alpha",
  "message_beta",
  "message_head",
  "message_reply",
  "note_alpha",
  "plan_fixture",
  "subscription_alpha",
  "tier_fixture",
]);
const IDENTITY_REFERENCE_KEY_PATTERN = /(?:^id$|(?:Id|_id|Ref|_ref)$|^createdBy$|^inReplyTo(?:Root)?$)/u;
const IDENTITY_MARKER_KEY_PATTERN = /(?:display.?name|username)$/iu;
const SYNTHETIC_IDENTITY_MARKERS = new Set([
  "Fixture Creator",
  "Fixture Fan",
  "Fixture Fan Beta",
  "fixture_creator",
  "fixture_fan",
  "fixture_fan_beta",
]);
const MONEY_KEY_PATTERN = /(?:amount|balance|gross|net|price|tip)/iu;
const SYNTHETIC_MONEY_VALUES = new Map<string, ReadonlySet<number>>([
  ["price", new Set([1234])],
  ["renewPrice", new Set([1456])],
  ["totalTipAmount", new Set([0, 321])],
]);
const CREDENTIAL_KEY_PATTERN = /(?:authorization|check|email|session|token)/iu;
const SIGNED_QUERY_KEY_PATTERN = /(?:key.?pair|policy|signature|signed.*(?:query|url)|x-amz)/iu;
const SIGNED_QUERY_VALUE_PATTERN = /(?:^|[?&])(?:expires|key-pair-id|policy|signature|x-amz-[\w-]+)=/iu;

async function listJsonFiles(directory: string) {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function inspectSyntheticValue(value: unknown, key: string | null = null): void {
  if (typeof value === "string") {
    let decoded = value;
    for (let pass = 0; pass < 2; pass += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          break;
        }
        decoded = next;
      } catch {
        // A malformed escape is still inspected in its last valid form.
        break;
      }
    }
    expect(decoded).not.toMatch(/https?:\/\//iu);
    expect(decoded).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu);
    expect(decoded).not.toContain("@");
    expect(decoded).not.toMatch(SIGNED_QUERY_VALUE_PATTERN);
    if (/^\d{15,}$/u.test(value)) {
      expect(SYNTHETIC_SNOWFLAKES.has(value)).toBe(true);
    }
    if (key !== null && IDENTITY_REFERENCE_KEY_PATTERN.test(key)) {
      expect(SYNTHETIC_IDENTIFIERS.has(value)).toBe(true);
    }
    if (key !== null && IDENTITY_MARKER_KEY_PATTERN.test(key)) {
      expect(SYNTHETIC_IDENTITY_MARKERS.has(value)).toBe(true);
    }
    if (key === "content") {
      expect(value).toBe("");
    }
    return;
  }

  if (typeof value === "number" && key !== null && MONEY_KEY_PATTERN.test(key)) {
    expect(SYNTHETIC_MONEY_VALUES.get(key)?.has(value) ?? false).toBe(true);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      inspectSyntheticValue(item);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      expect(childKey).not.toMatch(CREDENTIAL_KEY_PATTERN);
      expect(childKey).not.toMatch(SIGNED_QUERY_KEY_PATTERN);
      inspectSyntheticValue(childValue, childKey);
    }
  }
}

/** The privacy half of the inspection, applied to the statistics fixtures: no
 *  URLs, no emails, no `@`, no credential-shaped keys, no signed-query material
 *  — and every long identifier structurally synthetic. */
function inspectStatsFixtureValue(value: unknown, key: string | null = null): void {
  if (typeof value === "string") {
    let decoded = value;
    for (let pass = 0; pass < 2; pass += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          break;
        }
        decoded = next;
      } catch {
        break;
      }
    }
    // `_fixture` carries the provenance note, which is prose about a live
    // capture rather than data from one.
    if (key !== "_fixture") {
      expect(decoded).not.toMatch(/https?:\/\//iu);
      expect(decoded).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu);
      expect(decoded).not.toContain("@");
      expect(decoded).not.toMatch(SIGNED_QUERY_VALUE_PATTERN);
    }
    for (const candidate of value.match(/\d{15,}/gu) ?? []) {
      expect(candidate, `${key ?? "value"} carries a non-synthetic identifier`)
        .toMatch(STATS_SYNTHETIC_ID_PATTERN);
    }
    return;
  }

  if (typeof value === "number") {
    // A raw snowflake that slipped in as a NUMBER would be unreadable as an id
    // downstream anyway, but it would still be live data.
    expect(String(Math.trunc(Math.abs(value)))).not.toMatch(/^\d{15,}$/u);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      inspectStatsFixtureValue(item);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      expect(childKey).not.toMatch(CREDENTIAL_KEY_PATTERN);
      expect(childKey).not.toMatch(SIGNED_QUERY_KEY_PATTERN);
      inspectStatsFixtureValue(childValue, childKey);
    }
  }
}

/**
 * The stats inspector, with the `@` rule swapped for the address rule above.
 *
 * It is applied to every string in the tree, `metadata` included — and
 * `metadata` is where it earns its keep, because the address is nested inside a
 * JSON-ENCODED STRING where a naive key-based check would never look.
 */
function inspectPayoutFixtureValue(value: unknown, key: string | null = null): void {
  if (typeof value === "string") {
    let decoded = value;
    for (let pass = 0; pass < 2; pass += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          break;
        }
        decoded = next;
      } catch {
        break;
      }
    }
    if (key !== "_fixture") {
      expect(decoded).not.toMatch(/https?:\/\//iu);
      expect(decoded).not.toMatch(SIGNED_QUERY_VALUE_PATTERN);
      // EVERY address-shaped substring must sit on the reserved domain...
      let residue = decoded;
      for (const address of decoded.match(/[\w.+-]+@[\w.-]+/gu) ?? []) {
        expect(address.split("@").pop(), `${key ?? "value"} carries a routable address`)
          .toBe(PAYOUTS_SYNTHETIC_EMAIL_DOMAIN);
        residue = residue.split(address).join("");
      }
      // ...and nothing that is not an address may carry an `@` at all.
      expect(residue, `${key ?? "value"} carries a stray @`).not.toContain("@");
    }
    for (const candidate of value.match(/\d{15,}/gu) ?? []) {
      expect(candidate, `${key ?? "value"} carries a non-synthetic identifier`)
        .toMatch(STATS_SYNTHETIC_ID_PATTERN);
    }
    return;
  }

  if (typeof value === "number") {
    expect(String(Math.trunc(Math.abs(value)))).not.toMatch(/^\d{15,}$/u);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      inspectPayoutFixtureValue(item);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      // `metadata` is a KEY here and it is not a credential name, but what it
      // CONTAINS is checked above like every other string.
      expect(childKey).not.toMatch(SIGNED_QUERY_KEY_PATTERN);
      inspectPayoutFixtureValue(childValue, childKey);
    }
  }
}

describe("Fansly fixture privacy", () => {
  it("keeps the archived live response corpus out of the working tree", async () => {
    expect(await listJsonFiles(LEGACY_RESPONSE_DIRECTORY)).toEqual([]);
  });

  it("allows only the minimal synthetic fixture set and rejects sensitive payloads", async () => {
    const fixtureNames = await listJsonFiles(FIXTURE_DIRECTORY);
    expect(fixtureNames).toEqual(EXPECTED_FIXTURES);

    for (const fixtureName of fixtureNames) {
      const raw = await readFile(path.join(FIXTURE_DIRECTORY, fixtureName), "utf8");
      expect(Buffer.byteLength(raw)).toBeLessThan(8_192);
      inspectSyntheticValue(JSON.parse(raw) as unknown);
    }
  });

  it("keeps every WP-F2 engagement fixture structurally synthetic", async () => {
    const fixtureNames = await listJsonFiles(ENGAGEMENT_FIXTURE_DIRECTORY);
    expect(fixtureNames.length).toBeGreaterThan(0);

    for (const fixtureName of fixtureNames) {
      const raw = await readFile(path.join(ENGAGEMENT_FIXTURE_DIRECTORY, fixtureName), "utf8");
      expect(Buffer.byteLength(raw), fixtureName).toBeLessThan(ENGAGEMENT_FIXTURE_MAX_BYTES);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(typeof parsed._fixture, fixtureName).toBe("string");
      expect(String(parsed._fixture)).toMatch(/SYNTHETIC/u);
      // The same inspector: no URLs, no emails, no `@`, no credential-shaped
      // keys, and every 15+ digit identifier structurally fabricated.
      inspectStatsFixtureValue(parsed);
    }
  });

  it("keeps every WP-F7 payout fixture synthetic, addresses included", async () => {
    const fixtureNames = await listJsonFiles(PAYOUTS_FIXTURE_DIRECTORY);
    expect(fixtureNames.length).toBeGreaterThan(0);

    for (const fixtureName of fixtureNames) {
      const raw = await readFile(path.join(PAYOUTS_FIXTURE_DIRECTORY, fixtureName), "utf8");
      expect(Buffer.byteLength(raw), fixtureName).toBeLessThan(PAYOUTS_FIXTURE_MAX_BYTES);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(typeof parsed._fixture, fixtureName).toBe("string");
      expect(String(parsed._fixture)).toMatch(/SYNTHETIC/u);
      inspectPayoutFixtureValue(parsed);
    }
  });

  it("keeps every WP-F5 comment fixture structurally synthetic", async () => {
    const fixtureNames = await listJsonFiles(COMMENTS_FIXTURE_DIRECTORY);
    expect(fixtureNames.length).toBeGreaterThan(0);

    for (const fixtureName of fixtureNames) {
      const raw = await readFile(path.join(COMMENTS_FIXTURE_DIRECTORY, fixtureName), "utf8");
      expect(Buffer.byteLength(raw), fixtureName).toBeLessThan(COMMENTS_FIXTURE_MAX_BYTES);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(typeof parsed._fixture, fixtureName).toBe("string");
      expect(String(parsed._fixture)).toMatch(/SYNTHETIC/u);
      // The same inspector. It matters more here than anywhere else in this
      // file: a comment body is a FAN'S OWN WORDS, and a pasted capture would
      // put a real person's sentence in the repository under a name.
      inspectStatsFixtureValue(parsed);
    }
  });

  it("keeps every WP-F3 catalog fixture structurally synthetic", async () => {
    const fixtureNames = await listJsonFiles(CATALOG_FIXTURE_DIRECTORY);
    expect(fixtureNames.length).toBeGreaterThan(0);

    for (const fixtureName of fixtureNames) {
      const raw = await readFile(path.join(CATALOG_FIXTURE_DIRECTORY, fixtureName), "utf8");
      expect(Buffer.byteLength(raw), fixtureName).toBeLessThan(CATALOG_FIXTURE_MAX_BYTES);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(typeof parsed._fixture, fixtureName).toBe("string");
      expect(String(parsed._fixture)).toMatch(/SYNTHETIC/u);
      // The same inspector: no URLs, no emails, no `@`, no credential-shaped
      // keys, and every 15+ digit identifier structurally fabricated. The
      // no-URL half is load-bearing HERE and not decorative: two of these
      // shapes embed raw media rows whose `location`/`locations[]`/`variants[]`
      // are signed CDN URLs live, and the fixtures carry placeholders instead.
      inspectStatsFixtureValue(parsed);
    }
  });

  it("keeps every WP-F1 statistics fixture structurally synthetic", async () => {
    const fixtureNames = await listJsonFiles(STATS_FIXTURE_DIRECTORY);
    expect(fixtureNames.length).toBeGreaterThan(0);

    for (const fixtureName of fixtureNames) {
      const raw = await readFile(path.join(STATS_FIXTURE_DIRECTORY, fixtureName), "utf8");
      // A real /it/amoie/stats response is 768 KB decoded. A fixture anywhere
      // near that is a pasted capture, whatever its ids say.
      expect(Buffer.byteLength(raw), fixtureName).toBeLessThan(STATS_FIXTURE_MAX_BYTES);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Provenance is part of the fixture: it says which live shape it mirrors
      // and that the values are invented.
      expect(typeof parsed._fixture, fixtureName).toBe("string");
      expect(String(parsed._fixture)).toMatch(/SYNTHETIC/u);
      inspectStatsFixtureValue(parsed);
    }
  });
});
