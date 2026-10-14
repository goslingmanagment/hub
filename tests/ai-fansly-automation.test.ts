import { describe, expect, it } from "vitest";

import { fanslyMessageMarkers } from "@agency_hub_core/db";
import { FANSLY_WS_LIVE_FIELD } from "@agency_hub_core/shared";

import {
  AUTOMATED_MESSAGE_LABEL,
  FEATURE_POLICIES,
  HI_GREETING_TEMPLATE,
  fanslyAutomationReason,
  fanslyWelcomeTextSet,
  judgeFanslyTranscriptCoverage,
  readsTranscriptCoverage,
  type OperationFeature,
} from "../apps/runtime/src/modules/ai/index.ts";
import {
  AUTOMATION_DEFINITIONS,
  releasedAutomationReason,
  releasedIsAutomated,
  releasedWelcomeSet,
  type ReleasedFanslyMessage,
} from "./helpers/fansly-chat-automation.ts";

// chat-extension R20 HF-7д: the rules of the automation marks and of the
// coverage, against the released Fansly extension (fansly-chat 2.10.1). The
// stores, the route and the reference conversation are in
// tests/fansly-automation-transcript.integration.test.ts.

const PAGE = "700000000000000009";
const FAN = "700000000000000001";
const WELCOME = "hey babe, welcome to my page 💕 so glad you're here";

/** The hub's view of a served message: the markers as both stores keep them
 *  (the value pair and the presence bits), the reply, the transcript's text. */
function hubEvidence(message: ReleasedFanslyMessage) {
  const mask = (Object.hasOwn(message, "type") ? FANSLY_WS_LIVE_FIELD.type : 0)
    | (Object.hasOwn(message, "correlationId") ? FANSLY_WS_LIVE_FIELD.correlationId : 0);
  return {
    fromModel: message.senderId === PAGE,
    markers: fanslyMessageMarkers({
      type: typeof message.type === "number" ? message.type : null,
      correlationId: typeof message.correlationId === "string" ? message.correlationId : null,
      fieldMask: mask,
    }),
    inReplyTo: message.inReplyTo ?? null,
    text: message.content ?? "",
  };
}

/** Every combination of the keys the classifier reads, present or not. */
function matrix(): ReleasedFanslyMessage[] {
  const out: ReleasedFanslyMessage[] = [];
  let n = 0;
  for (const senderId of [PAGE, FAN]) {
    for (const type of [undefined, 0, 1, 2]) {
      for (const correlationId of [undefined, null, "0", "500000000000000001"]) {
        for (const inReplyTo of [undefined, null, "0", "800000000000000001"]) {
          for (const content of ["", "personal words", WELCOME, "  hey babe,  welcome to my page 💕\n so glad you're here "]) {
            const message: ReleasedFanslyMessage = { id: String(800_000_000_000_000_100n + BigInt(n++)), senderId, content };
            if (type !== undefined) message.type = type;
            if (correlationId !== undefined) message.correlationId = correlationId;
            if (inReplyTo !== undefined) message.inReplyTo = inReplyTo;
            out.push(message);
          }
        }
      }
    }
  }
  return out;
}

describe("[AI-033] the automation marks are the released Fansly extension's (chat-extension R20 HF-7д)", () => {
  it("the page's welcome texts are the same set as 2.10.1 reads from /message/automated", () => {
    const hub = fanslyWelcomeTextSet(AUTOMATION_DEFINITIONS.flatMap((row) => (
      row.messageTemplate.content === null ? [] : [row.messageTemplate.content]
    )));
    expect([...hub]).toEqual([...releasedWelcomeSet(AUTOMATION_DEFINITIONS)]);
    expect([...hub]).toEqual([WELCOME, "thanks for subscribing"]);
    // An empty or blank template names nothing.
    expect(fanslyWelcomeTextSet(["", "  \n "]).size).toBe(0);
  });

  it("every combination of type, correlationId, inReplyTo, sender and text classifies as 2.10.1 classifies it", () => {
    const welcome = releasedWelcomeSet(AUTOMATION_DEFINITIONS);
    const cases = matrix();
    expect(cases.length).toBe(512);
    for (const message of cases) {
      const released = message.senderId === PAGE ? releasedAutomationReason(message, welcome) : null;
      expect(fanslyAutomationReason(hubEvidence(message), welcome), JSON.stringify(message)).toBe(released);
      expect(released !== null).toBe(releasedIsAutomated(message, PAGE, welcome));
    }
  });

  it("a fan's message is personal whatever it carries; an unobserved marker is not automation", () => {
    const welcome = fanslyWelcomeTextSet([WELCOME]);
    const fan = { senderId: FAN, id: "1", type: 2, correlationId: "500000000000000001", content: WELCOME };
    expect(fanslyAutomationReason(hubEvidence(fan), welcome)).toBeNull();
    // The hub read the row before HF-7д0: neither marker observed.
    const unknown = {
      fromModel: true,
      markers: fanslyMessageMarkers({ type: 2, correlationId: "500000000000000001", fieldMask: null }),
      inReplyTo: null,
      text: "a mass send",
    };
    expect(unknown.markers).toEqual({ type: null, typeObserved: false, correlationId: null, correlationIdObserved: false });
    expect(fanslyAutomationReason(unknown, welcome)).toBeNull();
    // Its text still matches a welcome text.
    expect(fanslyAutomationReason({ ...unknown, text: WELCOME }, welcome)).toBe("welcome-text-match");
    // Without the welcome texts (their read failed), the markers alone decide.
    expect(fanslyAutomationReason({ ...unknown, text: WELCOME }, new Set())).toBeNull();
  });

  it("the label is the released one, and the Hi template explains it", () => {
    expect(AUTOMATED_MESSAGE_LABEL).toBe("[Automatic / mass message]");
    expect(HI_GREETING_TEMPLATE).toContain(`Model messages marked ${AUTOMATED_MESSAGE_LABEL} are welcome or mass messages`);
  });
});

describe("[AI-148] transcriptCoverage of a Fansly transcript the hub loads itself (chat-extension R20 HF-7д)", () => {
  const served = ["800000000000000002", "800000000000000003", "800000000000000010"];

  it("full history only on a proven chain whose start the served window reaches", () => {
    expect(judgeFanslyTranscriptCoverage({ chain: "complete", oldestRef: "800000000000000002", servedIds: served }))
      .toEqual({ value: "full-history", reachesOldest: true });
    // The hub holds nothing older than the window, but nothing proves the start.
    expect(judgeFanslyTranscriptCoverage({ chain: "unknown", oldestRef: "800000000000000002", servedIds: served }))
      .toEqual({ value: null, reachesOldest: true });
    // An empty archive: the window is all the hub holds.
    expect(judgeFanslyTranscriptCoverage({ chain: "complete", oldestRef: null, servedIds: [] }))
      .toEqual({ value: "full-history", reachesOldest: true });
  });

  it("a window, whatever the chain, when the hub holds an older message than it served", () => {
    for (const chain of ["complete", "partial", "unknown"] as const) {
      expect(judgeFanslyTranscriptCoverage({ chain, oldestRef: "800000000000000001", servedIds: served }))
        .toEqual({ value: "window", reachesOldest: false });
    }
    // Ids compare as Fansly's snowflakes: a shorter id is older.
    expect(judgeFanslyTranscriptCoverage({ chain: "complete", oldestRef: "99999999999999999", servedIds: served }).value)
      .toBe("window");
  });

  it("for the three features whose released client sends it", () => {
    const features = Object.keys(FEATURE_POLICIES) as OperationFeature[];
    expect(features.filter(readsTranscriptCoverage)).toEqual(["fan-summary", "coach-chat", "fan-notes-fill"]);
  });
});
