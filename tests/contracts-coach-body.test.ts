import { describe, expect, it } from "vitest";
import {
  AI_COVERAGE_CHECK_DELETED_MAX,
  AI_COVERAGE_CHECK_WINDOW_MAX,
  AI_FEATURE_CLIENT_MEDIA_MAX_ITEMS,
  AI_FEATURE_STREAM_BODY_LIMIT_BYTES,
  AI_KNOWN_FAN_MESSAGE_IDS_MAX,
  AI_LIVE_TEXT_MAX_CHARS,
  AI_LIVE_TEXT_MAX_ITEMS,
  AI_NOTE_FIELD_LABEL_MAX_CHARS,
  AI_NOTE_FIELDS_MAX,
  AI_NOTE_VALUE_MAX_CHARS,
  AI_START_PROOF_AUTOMATED_IDS_MAX,
  COACH_ANSWER_MAX_CHARS,
  FAN_SILENCE_DAYS_MAX,
  routeSchemas,
} from "@agency_hub_core/contracts";

const base = {
  clientRequestId: "5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f",
  pageLabel: "demo-page",
  platform: "fansly",
  conversationRef: "group-123",
};

describe("aiFeatureStream body — coach fields", () => {
  const schema = routeSchemas.aiFeatureStream.body;

  it("accepts coach fields within bounds", () => {
    const r = schema.safeParse({
      ...base,
      chatterQuestion: "как продать ppv?",
      coachHistory: [{ question: "q1", answer: "a1" }],
      clientContext: {
        transcript: "fan: hi", messageCount: 1, fanDisplayName: "Bob",
        transcriptCoverage: "window",
      },
    });
    expect(r.success, JSON.stringify(r)).toBe(true);
  });

  it("rejects out-of-bounds history", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      question: `q${i}`, answer: `a${i}`,
    }));
    expect(schema.safeParse({ ...base, coachHistory: tooMany }).success).toBe(false);
    // Option "c": the answer bound is the 64k TRANSPORT ceiling, not the old
    // 10k prompt bound — a 10k-plus answer replays verbatim within schema.
    expect(schema.safeParse({
      ...base,
      coachHistory: [{ question: "q", answer: "x".repeat(10_001) }],
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      coachHistory: [{ question: "q", answer: "x".repeat(64_000) }],
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      coachHistory: [{ question: "q", answer: "x".repeat(64_001) }],
    }).success).toBe(false);
  });

  it("accepts summaryMode 'short' only", () => {
    expect(schema.safeParse({ ...base, summaryMode: "short" }).success).toBe(true);
    expect(schema.safeParse({ ...base, summaryMode: "full" }).success).toBe(false);
  });

  it("accepts preset 'situation' only", () => {
    expect(schema.safeParse({ ...base, preset: "situation" }).success).toBe(true);
    expect(schema.safeParse({ ...base, preset: "other" }).success).toBe(false);
  });

  it("bounds fanSilenceDays to a whole number from 0 through the shared maximum", () => {
    const clientContext = {
      transcript: "fan: hi",
      messageCount: 1,
      fanDisplayName: "Bob",
      pingSegment: "segment-a",
    };
    expect(schema.safeParse({
      ...base,
      clientContext: { ...clientContext, fanSilenceDays: 0 },
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      clientContext: { ...clientContext, fanSilenceDays: FAN_SILENCE_DAYS_MAX },
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      clientContext: { ...clientContext, fanSilenceDays: -1 },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      clientContext: { ...clientContext, fanSilenceDays: FAN_SILENCE_DAYS_MAX + 1 },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      clientContext: { ...clientContext, fanSilenceDays: 1.5 },
    }).success).toBe(false);
  });
});

// Blocker 4 (P1-4) / round-4 P2-4: the scoped route bodyLimit is a BYTE budget
// enforced by Fastify BEFORE Zod, but the schema caps are CHAR counts. A
// static-math proof (not a multi-MB upload) that the configured limit clears the
// worst-case schema-valid body. The large free-text fields are content-agnostic
// plain bounded strings again -- the control-char ban was reverted (it regressed
// live Fansly features and was invisible in the OpenAPI) -- so the true
// per-code-unit worst case on the JSON wire is a SIX-byte "\uXXXX" escape.
describe("aiFeatureStream body limit vs the worst-case schema-valid body", () => {
  const schema = routeSchemas.aiFeatureStream.body;

  const scalars = {
    clientRequestId: "5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f",
    platform: "fansly",
    reasoningEffort: "max",
    replyTone: "spicy",
    replyMode: "preferSplit",
    messageCount: 3000,
    isRegeneration: true,
    preset: "situation",
    summaryMode: "short",
  } as const;

  // An avatar address is its Fansly host and then anything, 4,096 code units in all.
  const AVATAR_HOST = "https://a.fansly.com/";
  const AVATAR_URL_MAX_CHARS = 4096;

  // A body at EVERY field's max, each field filled with one code unit repeated,
  // so the serialized size is the worst case for that unit.
  const maxBodyFilledWith = (unit: string) => ({
    ...scalars,
    pageLabel: unit.repeat(120),
    conversationRef: unit.repeat(255),
    fanRef: unit.repeat(255),
    personaKey: unit.repeat(120),
    expectedPersonaDefinitionId: unit.repeat(100),
    model: unit.repeat(100),
    draftText: unit.repeat(20_000),
    chatterQuestion: unit.repeat(2_000),
    // fan-notes-fill: 30 labels of 60 code units, kept distinct by a two-digit
    // tail (labels must not repeat). ~11KB at six bytes a unit.
    noteFields: Array.from(
      { length: AI_NOTE_FIELDS_MAX },
      (_, index) => `${unit.repeat(AI_NOTE_FIELD_LABEL_MAX_CHARS - 2)}${String(index).padStart(2, "0")}`,
    ),
    // fan-notes-fill merge mode: one current value per label, each at the
    // 2,000-code-unit cap. 60k code units, ~360KB at six bytes a unit.
    noteValues: Array.from({ length: AI_NOTE_FIELDS_MAX }, () => unit.repeat(AI_NOTE_VALUE_MAX_CHARS)),
    // Ids are digits only, so their worst case does not depend on `unit`:
    // ten distinct 30-digit ids.
    knownFanMessageIds: Array.from(
      { length: AI_KNOWN_FAN_MESSAGE_IDS_MAX },
      (_, index) => `${index + 1}`.padEnd(30, "9"),
    ),
    // R20 HF-8в, the window coverage check: 60 window ids with their side and
    // 60 deleted ids, 120 distinct 30-digit ids in all (no id may repeat
    // across the two lists). Digits only, so ~5KB whatever `unit` is.
    coverageCheck: {
      window: Array.from({ length: AI_COVERAGE_CHECK_WINDOW_MAX }, (_, index) => ({
        id: `1${String(index).padStart(29, "0")}`,
        dir: "model" as const,
      })),
      deletedIds: Array.from(
        { length: AI_COVERAGE_CHECK_DELETED_MAX },
        (_, index) => `2${String(index).padStart(29, "0")}`,
      ),
    },
    // R20 HF-5, Hi on Fansly by the start proof. The proof is ids and counts:
    // a witness and 120 automatic ids of 30 digits, about 4KB whatever `unit`
    // is. The avatar's address is free text after its Fansly host: 4,096 code
    // units, about 24.5KB at six bytes a unit. The service takes them on Hi
    // without clientContext only, but that is decided after this byte limit and
    // the schema: the worst schema-valid body has them beside everything else.
    startProof: {
      v: 1 as const,
      source: "tab-short-page" as const,
      groupId: "9".repeat(30),
      startWitnessId: `1${"0".repeat(29)}`,
      coveredCount: Number.MAX_SAFE_INTEGER,
      personalCount: Number.MAX_SAFE_INTEGER - AI_START_PROOF_AUTOMATED_IDS_MAX,
      automatedIds: Array.from(
        { length: AI_START_PROOF_AUTOMATED_IDS_MAX },
        (_, index) => `1${String(index + 1).padStart(29, "0")}`,
      ),
    },
    personalMessageCount: Number.MAX_SAFE_INTEGER,
    fanAvatarUrl: `${AVATAR_HOST}${unit.repeat(AVATAR_URL_MAX_CHARS - AVATAR_HOST.length)}`,
    // 20 x (2k question + 64k answer) = the 1.32M-code-unit bulk.
    coachHistory: Array.from({ length: 20 }, () => ({
      question: unit.repeat(2_000),
      answer: unit.repeat(COACH_ANSWER_MAX_CHARS),
    })),
    // chat-extension H-4c (critic item 4): fresh text is 60 x 5k = 300k more
    // code units. The service refuses it on Coach and beside clientContext, but
    // only after this byte limit and the schema, and the schema cannot refuse
    // it (the feature is a path parameter): the worst schema-valid body has
    // both. Ids and instants are bounded and do not depend on `unit`.
    liveTextContext: {
      capturedAt: "2026-10-04T10:20:00.123456789+03:00",
      items: Array.from({ length: AI_LIVE_TEXT_MAX_ITEMS }, (_, index) => ({
        platformMessageId: `${index + 1}`.padEnd(30, "9"),
        direction: "model",
        occurredAt: "2026-10-04T10:20:00.123456789+03:00",
        text: unit.repeat(AI_LIVE_TEXT_MAX_CHARS),
      })),
    },
    clientContext: {
      transcript: unit.repeat(300_000),
      messageCount: 5000,
      fanDisplayName: unit.repeat(200),
      fanSpendingData: unit.repeat(20_000),
      fanSubscriptionData: unit.repeat(20_000),
      fanBio: unit.repeat(5_000),
      // The greeting fields of the released clients: two names of 200 code
      // units and their own avatar address, about 27KB at six bytes a unit.
      fanCustomName: unit.repeat(200),
      fanUsername: unit.repeat(200),
      fanAvatarUrl: `${AVATAR_HOST}${unit.repeat(AVATAR_URL_MAX_CHARS - AVATAR_HOST.length)}`,
      personalMessageCount: 5000,
      pingSegment: "segment-a",
      fanSilenceDays: FAN_SILENCE_DAYS_MAX,
      transcriptCoverage: "full-history",
      // ids are digits only, so their worst case does not depend on `unit`.
      media: {
        groupRef: "9".repeat(32),
        items: Array.from({ length: AI_FEATURE_CLIENT_MEDIA_MAX_ITEMS }, (_, index) => ({
          n: index + 1,
          placement: "appended",
          messageId: "9".repeat(32),
          sentAt: 8_640_000_000_000_000,
          sender: "fan",
          kind: "photo",
          mediaId: "9".repeat(32),
          paid: false,
        })),
      },
    },
  });

  it("a 3-byte-UTF-8 (の) worst case is schema-valid and fits 12 MiB (>4 MiB)", () => {
    // "の" is 3 UTF-8 bytes and 1 UTF-16 code unit -- the byte-per-char worst
    // case among PRINTABLE chars for z.string().max() (astral chars are 2 code
    // units -> 4 bytes = fewer bytes/unit, so they never dominate). ~1.69M
    // units x 3 ~= 5.06MB of text before fresh text; measured with the media
    // list and JSON framing, 5.27MB before fresh text, 6.18MB with it,
    // 6.36MB with the note values (60k units, ~0.18MB at three bytes) and
    // 6.39MB with the greeting fields and the start proof.
    const worstCase = maxBodyFilledWith("の");
    expect(schema.safeParse(worstCase).success, "の worst case must be schema-valid").toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(worstCase), "utf8");
    // The historical 4 MiB limit 413'd this contract-valid request.
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(bytes).toBeLessThan(AI_FEATURE_STREAM_BODY_LIMIT_BYTES);
  });

  it("a lone-high-surrogate (U+D800) worst case is schema-valid and fits 12 MiB (>8 MiB)", () => {
    // Round-4 P2-4: with the control-char ban reverted, the TRUE worst case is a
    // lone surrogate. "\ud800" is a legal JSON string value (1 UTF-16 code unit,
    // so z.string().max() accepts it) that JSON.stringify escapes to a SIX-byte
    // "\ud800" sequence -- ~1.69M units x 6 ~= 10.1MB of text (10.33MB with the
    // media list and framing) before fresh text, 12.15MB with it, 12.51MB with
    // the notes fill's values, 12.56MB with the released clients' greeting
    // fields (27KB, uncounted here until R20 HF-5) and HF-5's start proof and
    // top-level avatar (29KB). The former 8 MiB limit would have 413'd this
    // contract-valid body; 12 MiB (12.58MB) still clears it, by about 18KB.
    const worstCase = maxBodyFilledWith("\ud800");
    expect(schema.safeParse(worstCase).success, "surrogate worst case must be schema-valid").toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(worstCase), "utf8");
    // Proves why 12 MiB was needed: the six-byte escape blows past the old 8 MiB.
    expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
    // A field added to the body after fresh text has to be added to
    // maxBodyFilledWith above: this is the assertion that then says whether the
    // limit must rise with it.
    expect(bytes).toBeLessThan(AI_FEATURE_STREAM_BODY_LIMIT_BYTES);
  });

  it("the coverage check is about 5KB of that worst case (R20 HF-8в)", () => {
    const withCheck = maxBodyFilledWith("\ud800");
    const { coverageCheck, ...withoutCheck } = withCheck;
    expect(coverageCheck.window).toHaveLength(60);
    expect(coverageCheck.deletedIds).toHaveLength(60);
    const added = Buffer.byteLength(JSON.stringify(withCheck), "utf8")
      - Buffer.byteLength(JSON.stringify(withoutCheck), "utf8");
    // 120 ids of 30 digits, the sides and the JSON framing.
    expect(added).toBeGreaterThan(120 * 30);
    expect(added).toBeLessThan(8 * 1024);
  });

  it("the start proof, its count and the top-level avatar are about 29KB of that worst case (R20 HF-5)", () => {
    const withProof = maxBodyFilledWith("\ud800");
    const { startProof, personalMessageCount, fanAvatarUrl, ...withoutProof } = withProof;
    expect(startProof.automatedIds).toHaveLength(120);
    expect(fanAvatarUrl).toHaveLength(AVATAR_URL_MAX_CHARS);
    expect(personalMessageCount).toBe(Number.MAX_SAFE_INTEGER);
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
    // The proof: 122 ids of 30 digits, two 16-digit counts and the framing.
    expect(size({ startProof })).toBeGreaterThan(122 * 30);
    expect(size({ startProof })).toBeLessThan(5 * 1024);
    // The avatar: its host, then 4,075 code units at six bytes each.
    expect(size({ fanAvatarUrl })).toBeGreaterThan((AVATAR_URL_MAX_CHARS - AVATAR_HOST.length) * 6);
    expect(size({ fanAvatarUrl })).toBeLessThan(25 * 1024);
    const added = size(withProof) - size(withoutProof);
    expect(added).toBeGreaterThan(28 * 1024);
    expect(added).toBeLessThan(30 * 1024);
    // What is left under the limit with every field counted.
    expect(AI_FEATURE_STREAM_BODY_LIMIT_BYTES - size(withProof)).toBeGreaterThan(16 * 1024);
  });

  it("the notes fill's current values are about 360KB of that worst case", () => {
    const withValues = maxBodyFilledWith("\ud800");
    const { noteValues, ...withoutValues } = withValues;
    expect(noteValues).toHaveLength(30);
    const added = Buffer.byteLength(JSON.stringify(withValues), "utf8")
      - Buffer.byteLength(JSON.stringify(withoutValues), "utf8");
    // 30 x 2000 code units x 6 bytes, plus the quotes, commas and the key.
    expect(added).toBeGreaterThan(30 * 2_000 * 6);
    expect(added).toBeLessThan(30 * 2_000 * 6 + 1024);
  });

  it("fresh text alone is 1.8MB of that worst case (critic item 4)", () => {
    const withFreshText = maxBodyFilledWith("\ud800");
    const { liveTextContext, ...withoutFreshText } = withFreshText;
    expect(liveTextContext.items).toHaveLength(60);
    const added = Buffer.byteLength(JSON.stringify(withFreshText), "utf8")
      - Buffer.byteLength(JSON.stringify(withoutFreshText), "utf8");
    // 60 x 5000 code units x 6 bytes, plus the ids, instants and JSON framing.
    expect(added).toBeGreaterThan(60 * 5_000 * 6);
    expect(added).toBeLessThan(60 * 5_000 * 6 + 16 * 1024);
  });
});
