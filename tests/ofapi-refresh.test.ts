import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfapiClient, OfapiApiError, OfapiCredentialNotReadyError, ofapiAccountNotFound, toFansListPage, toAccountRecords, type OfapiCreditSpendObservation } from "../apps/runtime/src/services/ofapi.ts";
import { onlyfansTopSpendersChunk, onlyfansTransactionsChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { resolveOfapiAudienceNextOffset } from "../apps/runtime/src/services/sync/ofapi-audience-sync.ts";
import { resolveOfapiReadGatewayRequest } from "../apps/runtime/src/services/ofapi-read-gateway.ts";
import { validateOfapiInteractiveResponseShape } from "../apps/runtime/src/services/ofapi-capture-contract.ts";

afterEach(() => vi.unstubAllGlobals());
const ACCOUNT = "acct_test";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("OFAPI release compatibility boundaries", () => {
  it("uses top-level numeric identity, explicit nested fallback, and refuses conflicts", () => {
    const result = toAccountRecords({ data: [
      { id: ACCOUNT, onlyfans_id: 123 },
      { id: "acct_nested", onlyfans_user_data: { id: 456 } },
      { id: "acct_conflict", onlyfans_id: 123, onlyfans_user_data: { id: 456 } },
      { id: "acct_unknown", onlyfans_username: "same-name" },
      { id: "acct_unsafe", onlyfans_id: Number.MAX_SAFE_INTEGER + 1 },
    ] });
    expect(result.map(row => [row.onlyfansUserId, row.identityStatus])).toEqual([
      ["123", "verified"], ["456", "nested_fallback"], [null, "conflict"], [null, "missing"], [null, "conflict"],
    ]);
  });

  it("rejects malformed fan pages instead of certifying empty membership", () => {
    expect(() => toFansListPage({ data: {} })).toThrow();
    expect(() => toFansListPage({ data: { list: [] } })).toThrow("continuation");
    expect(() => toFansListPage({ data: { list: [null], hasMore: false } })).toThrow();
  });

  it.each([19, 0])("uses vendor continuation for a %i-row page", count => {
    expect(resolveOfapiAudienceNextOffset({ items: Array(count).fill({}), hasNextPage: true,
      nextPageUrl: `/api/${ACCOUNT}/fans/active?offset=20&limit=20`,
    }, { accountId: ACCOUNT, offset: 0, limit: 20 })).toBe(20);
  });
  it.each([
    `/api/${ACCOUNT}/fans/active?offset=0`,
    "/api/acct_other/fans/active?offset=20",
    `/api/${ACCOUNT}/chats?offset=20`,
    `https://evil.example/api/${ACCOUNT}/fans/active?offset=20`,
    `/api/${ACCOUNT}/fans/active?offset=20&offset=40`,
    `/api/${ACCOUNT}/fans/active?offset=20&filter[online]=1`,
  ])("rejects unsafe or stalled continuation %s", nextPageUrl => {
    expect(() => resolveOfapiAudienceNextOffset({ items: [], hasNextPage: true, nextPageUrl },
      { accountId: ACCOUNT, offset: 0, limit: 20 })).toThrow();
  });
  it("advances an empty hasMore page and ends only on explicit terminal evidence", () => {
    expect(resolveOfapiAudienceNextOffset({ items: [], hasNextPage: true }, { accountId: ACCOUNT, offset: 20, limit: 20 })).toBe(40);
    expect(resolveOfapiAudienceNextOffset({ items: [], hasNextPage: false }, { accountId: ACCOUNT, offset: 20, limit: 20 })).toBeNull();
  });
  it("routes search IDs separately, keeps pinned scope, and blocks reserved users", () => {
    const search = resolveOfapiReadGatewayRequest(`${ACCOUNT}/chats/123/messages/search`, { query: "hello" });
    expect(search).toMatchObject({ operation: "ofapi_gateway_chat_search" });
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_chat_search", { data: [123, 456] })).toBe(true);
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_chat_message", { data: [123, 456] })).toBe(false);
    expect(resolveOfapiReadGatewayRequest(`${ACCOUNT}/chats/123/messages`, { filter: "pinned" })).toMatchObject({ query: { filter: "pinned" } });
    for (const name of ["blocked", "restricted", "search"]) expect(() => resolveOfapiReadGatewayRequest(`${ACCOUNT}/users/${name}`, {})).toThrow();
    expect(resolveOfapiReadGatewayRequest(`${ACCOUNT}/chats/123/media`, { type: "photo" })).toMatchObject({ query: { type: "photos" } });
    expect(resolveOfapiReadGatewayRequest(`${ACCOUNT}/media/vault/lists`, { lightweight: "true" })).toMatchObject({ query: { lightweight: "true" } });
  });
  it("routes retired transactions and disabled spenders into skip finalization without paid reads", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const app = { config: { onlyFansTopSpendersEnabled: false } } as unknown as Parameters<typeof onlyfansTopSpendersChunk>[0];
    const input = { pageContext: { platform: "onlyfans" }, telemetry: { recordPhaseStarted: vi.fn() } } as unknown as Parameters<typeof onlyfansTransactionsChunk>[1];
    expect(await onlyfansTopSpendersChunk(app, input)).toMatchObject({ gatedSkip: "onlyfans_top_spenders_disabled" });
    expect(await onlyfansTransactionsChunk(app, input)).toMatchObject({ gatedSkip: "onlyfans_transactions_webhook_sourced" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("distinguishes a missing account from message 404s and edge errors", () => {
    expect(ofapiAccountNotFound(404, '{"error":{"code":"account_not_found"}}')).toBe(true);
    expect(ofapiAccountNotFound(404, '{"error":{"code":"message_not_found"}}')).toBe(false);
    expect(ofapiAccountNotFound(403, "<html>denied</html>")).toBe(false);
  });
});

describe("free balance and credential adoption", () => {
  it.each([0, 9500, null])("reads free team balance %s without a page or paid fallback", async balance => {
    const spend: OfapiCreditSpendObservation[] = [];
    const fetch = vi.fn(async (_url: string) => response(balance === null ? { data: {} } : { data: {}, _credits: { used: 0, balance } }));
    vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "synthetic-test-key", restDelayMs: 0, onCreditSpend: row => { spend.push(row); } });
    const result = await client.pingBalance({});
    expect(result.meta?.creditBalance ?? null).toBe(balance);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/usage/credits?from=");
    expect(spend).toMatchObject([{ credits: 0, estimated: false, pageId: null }]);
  });
  it.each([
    [200, { team: { slug: "expected" } }, "verified"],
    [200, { team: { slug: "wrong" } }, "mismatch"],
    [200, { api_key: { name: "restricted" } }, "unknown"],
    [403, { error: "forbidden" }, "denied"],
  ] as const)("classifies whoami %s as %s", async (status, body, expected) => {
    const fetch = vi.fn(async () => response(body, status)); vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "synthetic-test-key", restDelayMs: 0, credentialPolicy: { expectedTeamSlug: "expected" } });
    expect(await client.getCredentialPreflight!()).toMatchObject({ status: expected, rosterScope: "unknown" });
    if (expected !== "verified") {
      const refused = client.createWebhook({ endpointUrl: "https://hub.test", events: [], signingSecret: "synthetic", accountScope: "global" });
      await expect(refused).rejects.toBeInstanceOf(OfapiCredentialNotReadyError);
      await expect(refused).rejects.toBeInstanceOf(OfapiApiError);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("never reuses credential adoption across different keys", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ team: { slug: "expected" } }))
      .mockResolvedValueOnce(response({ team: { slug: "wrong" } }));
    vi.stubGlobal("fetch", fetch);
    const first = createOfapiClient({ apiKey: "synthetic-first", restDelayMs: 0, credentialPolicy: { expectedTeamSlug: "expected" } });
    const second = createOfapiClient({ apiKey: "synthetic-second", restDelayMs: 0, credentialPolicy: { expectedTeamSlug: "expected" } });
    const firstResult = await first.getCredentialPreflight!();
    const secondResult = await second.getCredentialPreflight!();
    expect(firstResult.status).toBe("verified");
    expect(secondResult.status).toBe("mismatch");
    expect(secondResult.credentialFingerprint).not.toBe(firstResult.credentialFingerprint);
    expect(await first.getCredentialPreflight!()).toEqual(firstResult);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not discover expected team from the untrusted credential", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "synthetic-test-key", credentialPolicy: { expectedTeamSlug: null } });
    expect(await client.getCredentialPreflight!()).toMatchObject({ status: "unknown", reason: "expected_team_unconfigured" });
    await expect(client.sendTextMessage!({}, ACCOUNT, "1", { text: "test" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("captures admin raw bytes before malformed parsing and does not invent balance after access denial", async () => {
    const captured = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>edge</html>", { status: 403 })));
    const client = createOfapiClient({ apiKey: "synthetic-test-key", restDelayMs: 0, onAdminResponse: captured, credentialPolicy: { expectedTeamSlug: "expected" } });
    expect(await client.getCredentialPreflight!()).toMatchObject({ status: "unknown" });
    expect(captured).toHaveBeenCalledWith(expect.objectContaining({ status: 403, body: "<html>edge</html>" }));
    await expect(client.pingBalance({})).rejects.toThrow();
  });
});


describe("OFAPI roster receipt", () => {
  it("returns the transport capture receipt and keeps ordinary roster reads compatible", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('[{"id":"acct_x","onlyfans_id":123}]', { status: 200 })));
    const captures: Date[] = [];
    const client = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, onAdminResponse: async value => {
      captures.push(value.receivedAt);
      return { observationId: 7, receivedAt: value.receivedAt };
    } });
    const snapshot = await client.listAccountsSnapshot!();
    expect(snapshot.evidence).toEqual({ observationId: 7, receivedAt: captures[0] });
    expect(await client.listAccounts()).toEqual(snapshot.accounts);
    const uncaptured = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0 });
    expect((await uncaptured.listAccountsSnapshot!()).evidence).toBeNull();
  });
});
