import { afterEach, describe, expect, it, vi } from "vitest";
import { ofapiSendV2PayloadSchema } from "@agency_hub_core/contracts";
import { buildOfapiSendV2Body, ofapiExtendedAction, ofapiSentWebhookMatchesV2 } from "../apps/runtime/src/services/ofapi-command-composer.ts";
import { previewOfapiBannedWords } from "../apps/runtime/src/services/ofapi-banned-words.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
const payload = { text: "hello", priceCents: 697, mediaFiles: ["9007199254740993"], previews: [], lockedText: false, replyToMessageId: "9007199254740995", giphyId: null, rfTag: ["123"], rfPartner: [], rfGuest: [], blockBannedWords: "risky" as const, reuseProviderOperation: false };
afterEach(() => vi.unstubAllGlobals());
describe("send v2 and closed chat actions", () => {
  it("preserves cents, unsafe ids and every explicit composer field without applying hidden defaults", () => {
    expect(buildOfapiSendV2Body(payload)).toEqual({ text: "hello", price: 6.97, mediaFiles: ["9007199254740993"], previews: [], lockedText: false, replyToMessageId: "9007199254740995", rfTag: [123], blockBannedWords: "risky" });
    expect(ofapiSendV2PayloadSchema.safeParse({ ...payload, priceCents: 697.1 }).success).toBe(false);
    expect(ofapiSendV2PayloadSchema.safeParse({ ...payload, previews: ["12"] }).success).toBe(false);
  });
  it("one provider key travels on one physical send and replay alone cannot confirm success", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Idempotent-Replayed": "true", "X-OFAPI-Credits-Used": "0" } }));
    vi.stubGlobal("fetch", fetcher);
    const client = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0 });
    await expect(client.executeExtendedCommand!({}, "acct_a", "123", "send_message_v2", payload, "stable-key")).rejects.toThrow("message id");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1].headers["Idempotency-Key"]).toBe("stable-key");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body).price).toBe(6.97);
  });
  it("captures the raw send response with page attribution before credit interpretation", async () => {
    const order: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: "991" }, _meta: { _credits: { used: 1 } } }))));
    const client = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, onAdminResponse: async response => { order.push("capture"); expect(response.pageId).toBe(7); expect(response.accountId).toBe("acct_a"); return { observationId: 1, receivedAt: new Date() }; }, onCreditSpend: async () => { order.push("credit"); return true; } });
    expect(await client.executeExtendedCommand!({ pageId: 7 }, "acct_a", "123", "send_message_v2", payload, "stable-key")).toEqual({ messageId: "991" });
    expect(order).toEqual(["capture", "credit"]);
  });
  it("maps action methods precisely and never accepts an arbitrary write path", () => {
    expect(ofapiExtendedAction("set_fan_custom_name_v1", "acct_a", "123", { customName: "" })).toEqual({ method: "PUT", path: "/acct_a/fans/123/custom-name", body: { custom_name: "" } });
    expect(ofapiExtendedAction("unpin_message_v1", "acct_a", "123", { messageId: "456" }).method).toBe("DELETE");
    expect(ofapiExtendedAction("unmute_chat_v1", "acct_a", "123", {}).path).toBe("/acct_a/chats/123/unmute");
  });
  it("does not execute vendor regex or rewrite text; highlights literal repeats with evidence", () => {
    const dictionary = { version: "v1", observedAt: "2026-09-06T00:00:00.000Z", complete: false, pages: 1, entries: [{ word: "a+b", riskLevel: "risky", category: null, alternatives: "safe" }] };
    const result = previewOfapiBannedWords("A+B then a+b", dictionary);
    expect(result.matches.map(x => [x.start, x.end])).toEqual([[0,3],[9,12]]);
    expect(result.complete).toBe(false);
    expect(previewOfapiBannedWords("text", null)).toMatchObject({ version: null, complete: false, matches: [] });
  });
});

it("requires exact visible v2 evidence for webhook verification", () => {
  const actual = { text: "hello", price: 6.97, lockedText: false, replyToMessageId: "9007199254740995", media: [{id:"9007199254740993"}], rfTag: [123] };
  expect(ofapiSentWebhookMatchesV2(payload, actual)).toBe(true);
  expect(ofapiSentWebhookMatchesV2(payload, { ...actual, lockedText: undefined })).toBe(false);
  expect(ofapiSentWebhookMatchesV2({ ...payload, mediaFiles: ["ofapi_media_token"] }, actual)).toBe(false);
});
