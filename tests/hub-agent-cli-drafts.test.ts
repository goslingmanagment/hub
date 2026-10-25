import { describe, expect, it } from "vitest";

import { parseHubDraftFile } from "../packages/hub-agent-cli/src/commands.ts";

describe("a draft file from `publication-get`'s answer", () => {
  it("puts each file back where it belongs: the post's own media and previews, an extra attachment's into its entry", () => {
    const answer = {
      ok: true,
      data: {
        id: 7, version: 3, kind: "fyp_post", text: "teaser",
        media: [
          { role: "media", position: 0, source: "vault", mediaRef: "t1", fileId: null, attachment: 0 },
          { role: "media", position: 2, source: "file", mediaRef: null, fileId: 9, attachment: 1 },
          { role: "media", position: 1, source: "vault", mediaRef: "s1", fileId: null, attachment: 1 },
          { role: "preview", position: 1, source: "vault", mediaRef: "p1", fileId: null, attachment: 1 },
        ],
        extraAttachments: [{ attachment: 1, access: "paid", tierRefs: [], priceMills: 9_000, subscribersOnly: false }],
      },
    };
    expect(parseHubDraftFile(JSON.stringify(answer), ["version"])).toEqual({
      version: 3, kind: "fyp_post", text: "teaser",
      media: [{ source: "vault", mediaRef: "t1" }],
      previews: [],
      extraAttachments: [{
        access: "paid", tierRefs: [], priceMills: 9_000, subscribersOnly: false,
        media: [{ source: "vault", mediaRef: "s1" }, { source: "file", fileId: 9 }],
        previews: [{ source: "vault", mediaRef: "p1" }],
      }],
    });
  });
});
