import { describe, expect, it } from "vitest";
import {
  OFAPI_READ_CATALOG,
  resolveOfapiCatalogPath,
} from "@agency_hub_core/shared";
import { resolveOfapiReadGatewayRequest } from "../apps/runtime/src/services/ofapi-read-gateway.ts";
import { validateOfapiInteractiveResponseShape } from "../apps/runtime/src/services/ofapi-capture-contract.ts";
import {
  normalizeOfapiRead,
  ofapiReadCoverage,
  safeOfapiReadBody,
} from "../apps/runtime/src/services/ofapi-read-normalization.ts";
import {
  planOfapiReadCollection,
  type OfapiCollectionJob,
} from "../apps/runtime/src/services/ofapi-collection-runner.ts";
const def = (id: string) => OFAPI_READ_CATALOG.find((row) => row.id === id)!;
describe("closed OFAPI read coverage catalog", () => {
  it("resolves every catalog operation through the existing gateway with explicit policy context", () => {
    for (const row of OFAPI_READ_CATALOG) {
      const query = Object.fromEntries(
        (row.required ?? []).map((key) => [
          key,
          key === "start_date"
            ? "2026-09-01"
            : key === "end_date"
              ? "2026-09-02"
              : "search",
        ]),
      );
      const request = resolveOfapiReadGatewayRequest(
        `acct_test/${row.path.replace(":id", "9007199254740993")}`,
        query,
      );
      expect(request).toMatchObject({
        kind: "proxy",
        operation: row.operation,
        collectionContext: { category: row.category, purpose: "interactive" },
      });
      const data =
        row.shape === "object"
          ? {}
          : row.shape === "array"
            ? []
            : row.shape === "strings"
              ? []
              : { [row.shape]: [] };
      expect(
        validateOfapiInteractiveResponseShape(row.operation, { data }),
      ).toBe(true);
      expect(
        validateOfapiInteractiveResponseShape(row.operation, {
          unexpected: [],
        }),
      ).toBe(false);
    }
  });
  it("cannot write following preferences or query undocumented routes", () => {
    for (const query of [
      { sort: "expire_date" },
      { sortDirection: "asc" },
      { unknown: 1 },
      { limit: 51 },
      { offset: -1 },
    ])
      expect(() =>
        resolveOfapiReadGatewayRequest("acct_test/following/expired", query),
      ).toThrow();
    expect(resolveOfapiCatalogPath("acct_test/posts/1/replies", {})).toBeNull();
    expect(() =>
      resolveOfapiReadGatewayRequest("acct_test/fans/expired", { limit: 21 }),
    ).toThrow();
    expect(() =>
      resolveOfapiReadGatewayRequest("acct_test/fans/latest", {
        start_date: "2026-09-01",
      }),
    ).toThrow();
    expect(() =>
      resolveOfapiReadGatewayRequest("acct_test/giphy/search", {}),
    ).toThrow();
  });
  it("follows empty following pages until an explicit terminal link and rejects foreign/mutated cursors", () => {
    const row = def("following_expired"),
      path = "/acct_test/following/expired",
      query = { limit: "50", offset: "0" };
    const body = {
      data: { list: [], hasMore: true },
      _pagination: {
        next_page:
          "https://app.onlyfansapi.com/api/acct_test/following/expired?limit=50&offset=50",
      },
    };
    expect(ofapiReadCoverage(row, body, path, query)).toMatchObject({
      state: "partial",
      nextQuery: { offset: "50", limit: "50" },
    });
    for (const url of [
      "https://evil.test/api/acct_test/following/expired?offset=50",
      "https://app.onlyfansapi.com/api/acct_other/following/expired?offset=50",
      "https://app.onlyfansapi.com/api/acct_test/following/expired?offset=50&query=changed",
      "https://app.onlyfansapi.com/api/acct_test/following/expired?offset=0",
    ])
      expect(
        ofapiReadCoverage(
          row,
          { ...body, _pagination: { next_page: url } },
          path,
          query,
        ),
      ).toMatchObject({
        state: "partial",
        reason: "invalid_provider_continuation",
        nextQuery: null,
      });
    expect(
      ofapiReadCoverage(
        row,
        { data: { list: [] }, _pagination: { next_page: null } },
        path,
        query,
      ),
    ).toMatchObject({ state: "complete", nextQuery: null });
  });
  it("does not call filtered or indexed fan results a complete audience", () => {
    const body = {
      data: {
        list: [{ id: 1 }],
        hasMore: false,
        _source: { is_complete: false, omitted_from_page: 2 },
      },
    };
    expect(
      ofapiReadCoverage(
        def("fans_expired"),
        body,
        "/acct_test/fans/expired",
        {},
      ),
    ).toMatchObject({
      state: "partial",
      reason: "provider_index_incomplete",
      indexComplete: false,
      omitted: 2,
    });
    expect(
      ofapiReadCoverage(
        def("fans_top"),
        { data: { users: [{ id: 1 }] } },
        "/acct_test/fans/top",
        {},
      ),
    ).toMatchObject({ state: "partial", reason: "bounded_ranking" });
    expect(
      ofapiReadCoverage(
        def("subscriptions_history"),
        { data: { list: [], hasMore: true } },
        "/acct_test/fans/1/subscriptions-history",
        {},
      ),
    ).toMatchObject({ state: "partial", reason: "continuation_unavailable" });
  });
  it("separates stable CRM fields, mills, inline comments/replies and credential-free profile", () => {
    const fan = normalizeOfapiRead(def("fans_expired"), {
      data: {
        list: [
          {
            id: 1,
            username: "fan",
            totalSpent: "12.345",
            isBlocked: true,
            canReceiveChatMessage: true,
          },
        ],
        hasMore: false,
      },
    })[0];
    expect(fan).toMatchObject({
      nativeId: "1",
      contactability: "blocked",
      priorSpendMills: "12345",
    });
    const comment = normalizeOfapiRead(def("post_comments"), {
      data: {
        list: [
          {
            id: 2,
            text: "Comment",
            author: { id: 1 },
            replies: [{ id: 3, text: "Reply", author: { id: 4 } }],
          },
        ],
      },
    })[0];
    expect(comment).toMatchObject({
      fanId: "1",
      replies: [{ id: "3", text: "Reply", authorId: "4" }],
    });
    const privateBody = {
      data: {
        id: 5,
        username: "creator",
        csrf: "secret",
        wsAuthToken: "secret",
        email: "private",
        ip: "private",
        upload: { token: "secret" },
      },
    };
    expect(safeOfapiReadBody(def("me").operation, privateBody)).toEqual({
      data: { id: 5, username: "creator" },
    });
    expect(
      JSON.stringify(normalizeOfapiRead(def("me"), privateBody)),
    ).not.toContain("secret");
  });
  it("bounds default plans and requires explicit IDs for details", () => {
    const job = {
      category: "balances",
      target: {
        from: "2026-09-01T00:00:00Z",
        to: "2026-09-02T00:00:00Z",
        selection: [],
      },
    } as unknown as OfapiCollectionJob;
    const plan = planOfapiReadCollection(job, "acct_test");
    expect(plan.map((row) => row.operation)).toEqual([
      "ofapi_read_payout_balances",
      "ofapi_read_statistics_overview",
      "ofapi_read_subscriber_statistics",
    ]);
    expect(
      planOfapiReadCollection(
        {
          ...job,
          category: "profile_notifications",
          target: {
            ...job.target,
            selection: ["following_expired?offset=50&limit=50"],
          },
        },
        "acct_test",
      )[0]?.query,
    ).toEqual({ offset: "50", limit: "50" });
    expect(() =>
      planOfapiReadCollection(
        {
          ...job,
          category: "profile_notifications",
          target: {
            ...job.target,
            selection: ["following_expired?sort=is_expired"],
          },
        },
        "acct_test",
      ),
    ).toThrow();
    expect(plan[1]?.query).toEqual({
      start_date: job.target.from,
      end_date: job.target.to,
    });
    expect(() =>
      planOfapiReadCollection(
        {
          ...job,
          category: "posts_comments",
          target: { ...job.target, selection: ["post_comments"] },
        },
        "acct_test",
      ),
    ).toThrow();
    expect(
      planOfapiReadCollection(
        {
          ...job,
          category: "posts_comments",
          target: { ...job.target, selection: ["post_comments:123"] },
        },
        "acct_test",
      )[0],
    ).toMatchObject({
      pathname: "/acct_test/posts/123/comments",
      detail: true,
    });
  });
});
