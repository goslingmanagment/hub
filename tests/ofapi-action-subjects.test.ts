// Which subject refs an OFAPI action response indexes for erasure: a pure
// read of the response body. Erasure through those refs, against a real
// database, is ofapi-actions-erasure.integration.test.ts.

import { describe, expect, it } from "vitest";

import { ofapiActionResponseSubjectRefs } from "../apps/runtime/src/services/ofapi-action-subjects.ts";

describe("OFAPI action erasure", () => {
  it("indexes returned user relations without mistaking list, post or media IDs for fan IDs", () => {
    expect(ofapiActionResponseSubjectRefs({ action: "user_list_remove_user" }, {
      id: 9001, list: { id: 9002, users: [{ id: "123" }, { id: "9007199254740993" }] },
      media: [{ id: 9003 }], posts: [{ id: 9004 }], userState: { id: 9002 },
      nested: { userId: "456", fan_id: 789, fanIds: ["123", "567"], fan: { id: "678" } },
    })).toEqual(["123", "456", "567", "678", "789", "9007199254740993"]);
    expect(ofapiActionResponseSubjectRefs({ action: "user_block" }, { id: 123 })).toEqual(["123"]);
    expect(ofapiActionResponseSubjectRefs({ action: "account_me_get" }, { id: 123 })).toEqual([]);
    expect(ofapiActionResponseSubjectRefs({ action: "user_list_clear" }, { users: [{ id: 9007199254740992 }] })).toEqual([]);
  });
});
