import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const FIXTURE_DIRECTORY = path.resolve("tests/fixtures/fansly");
const LEGACY_RESPONSE_DIRECTORY = path.resolve("reference/responses");
const EXPECTED_FIXTURES = [
  "account_me.json",
  "followers.json",
  "group_detail.json",
  "message.json",
  "messaging_groups.json",
  "subscribers.json",
];
const SYNTHETIC_SNOWFLAKES = new Set(["863308077229670400"]);
const SYNTHETIC_IDENTIFIERS = new Set([
  ...SYNTHETIC_SNOWFLAKES,
  "acct_creator",
  "acct_fan_alpha",
  "group_alpha",
  "history_alpha",
  "message_head",
  "message_reply",
  "plan_fixture",
  "subscription_alpha",
  "tier_fixture",
]);
const IDENTITY_REFERENCE_KEY_PATTERN = /(?:^id$|(?:Id|_id|Ref|_ref)$|^createdBy$|^inReplyTo(?:Root)?$)/u;
const IDENTITY_MARKER_KEY_PATTERN = /(?:display.?name|username)$/iu;
const SYNTHETIC_IDENTITY_MARKERS = new Set([
  "Fixture Creator",
  "Fixture Fan",
  "fixture_creator",
  "fixture_fan",
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
});
