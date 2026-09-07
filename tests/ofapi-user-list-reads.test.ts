import { describe, expect, it } from "vitest";
import {
  OFAPI_READ_CATALOG,
  resolveOfapiCatalogPath,
} from "@agency_hub_core/shared";
import {
  normalizeOfapiRead,
  ofapiReadCoverage,
  validateOfapiCatalogResponse,
} from "../apps/runtime/src/services/ofapi-read-normalization.ts";
import {
  planOfapiReadCollection,
  type OfapiCollectionJob,
} from "../apps/runtime/src/services/ofapi-collection-runner.ts";
const def = (id: string) => OFAPI_READ_CATALOG.find((row) => row.id === id)!;
const job = (selection: string[]) =>
  ({
    category: "profile_notifications",
    target: { selection, from: null, to: null },
  }) as unknown as OfapiCollectionJob;
describe("durable user-list reads", () => {
  it("requires an explicit bounded read selection and safely admits documented named list IDs", () => {
    for (const row of OFAPI_READ_CATALOG.filter((row) =>
      row.id.startsWith("user_list"),
    )) {
      expect(row.category).toBe("profile_notifications");
      expect(row.defaultCollect).toBe(false);
    }
    expect(
      planOfapiReadCollection(job([]), "acct_test").some((step) =>
        step.operation.includes("user_list"),
      ),
    ).toBe(false);
    for (const id of ["friends", "tagged", "rebill_off", "9007199254740993"]) {
      const step = planOfapiReadCollection(
        job([`user_list_users:${id}?limit=20`]),
        "acct_test",
      )[0];
      expect(step).toMatchObject({
        pathname: `/acct_test/user-lists/${id}/users`,
        query: { limit: "20", offset: "0" },
        detail: true,
      });
      expect(
        resolveOfapiCatalogPath(step!.pathname, step!.query)?.definition.id,
      ).toBe("user_list_users");
    }
    for (const id of ["../other", "%2f", "a:b", "https://evil.test", "", "a-b"])
      expect(() =>
        planOfapiReadCollection(job([`user_list_users:${id}`]), "acct_test"),
      ).toThrow();
    expect(resolveOfapiCatalogPath("acct_test/posts/friends", {})).toBeNull();
    expect(() =>
      resolveOfapiCatalogPath("acct_test/user-lists", { limit: 9 }),
    ).toThrow();
    expect(() =>
      resolveOfapiCatalogPath("acct_test/user-lists/friends/users", {
        limit: 101,
      }),
    ).toThrow();
  });
  it("keeps provider counts and list previews distinct from full membership", () => {
    const row = normalizeOfapiRead(def("user_list"), {
      data: {
        id: "friends",
        type: "custom",
        name: "Friends",
        usersCount: 10,
        postsCount: 2,
        canManageUsers: false,
        users: [{ id: "9007199254740993", username: "fan" }],
      },
    })[0];
    expect(row).toMatchObject({
      nativeId: "friends",
      fanId: null,
      listId: "friends",
      listName: "Friends",
      usersCount: 10,
      canManageUsers: false,
      membershipCoverage: "preview_only",
      previewUsers: [{ fanId: "9007199254740993", username: "fan" }],
    });
    const body = { data: [{ id: "friends", usersCount: 10, users: [] }] };
    expect(
      ofapiReadCoverage(def("user_lists"), body, "/acct_test/user-lists", {
        limit: "50",
        offset: "0",
      }),
    ).toMatchObject({
      state: "unknown",
      reason: "continuation_unspecified",
      nextQuery: null,
    });
  });
  it("retains exact member identities and explicit false list state without interpreting pinned-only absence", () => {
    const row = normalizeOfapiRead(
      def("user_list_pinned_users"),
      {
        data: {
          list: [
            {
              id: "9007199254740993",
              canReceiveChatMessage: false,
              listsStates: [
                {
                  id: "friends",
                  name: "Friends",
                  hasUser: false,
                  canAddUser: false,
                  cannotAddUserReason: "restricted",
                },
              ],
            },
          ],
          hasMore: false,
        },
      },
      "/acct_test/user-lists/friends/users/pinned",
    )[0];
    expect(row).toMatchObject({
      fanId: "9007199254740993",
      listId: "friends",
      membershipScope: "pinned_only",
      membershipObserved: true,
      contactability: "unavailable",
      listStates: [
        {
          listId: "friends",
          hasUser: false,
          canAddUser: false,
          cannotAddUserReason: "restricted",
        },
      ],
    });
  });
  it("follows explicit continuation on an empty membership page and stops only on provider terminal evidence", () => {
    const row = def("user_list_users"),
      path = "/acct_test/user-lists/friends/users",
      query = { limit: "20", offset: "0" };
    expect(
      ofapiReadCoverage(
        row,
        { data: { list: [], hasMore: true, nextOffset: 20 } },
        path,
        query,
      ),
    ).toMatchObject({
      state: "partial",
      nextQuery: { limit: "20", offset: "20" },
    });
    expect(
      ofapiReadCoverage(
        row,
        { data: { list: [], hasMore: false, nextOffset: 20 } },
        path,
        query,
      ),
    ).toMatchObject({ state: "complete", nextQuery: null });
    expect(
      ofapiReadCoverage(row, { data: { list: [] } }, path, query),
    ).toMatchObject({ state: "unknown", nextQuery: null });
  });
  it("rejects wrong envelopes, missing identities, unsafe numeric IDs and URL-shaped named IDs", () => {
    for (const body of [
      { data: {} },
      { data: { id: "../unsafe" } },
      { data: { id: 9007199254740992 } },
    ])
      expect(
        validateOfapiCatalogResponse(def("user_list").operation, body),
      ).toBe(false);
    for (const body of [
      { data: [] },
      { data: { list: [{}] } },
      { data: { list: [{ id: "friends" }] } },
    ])
      expect(
        validateOfapiCatalogResponse(def("user_list_users").operation, body),
      ).toBe(false);
    expect(
      validateOfapiCatalogResponse(def("user_lists").operation, {
        data: [{ id: "friends" }, { id: "recent" }, { id: 123 }],
      }),
    ).toBe(true);
  });
});
