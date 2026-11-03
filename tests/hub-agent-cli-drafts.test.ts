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

  it("keeps the name a vault album's draft gave each file (0349): the album sent again names its cards the same", () => {
    const answer = {
      ok: true,
      data: {
        id: 8, kind: "vault_album", text: "SXT-003",
        media: [
          { role: "media", position: 1, source: "file", mediaRef: null, fileId: 12, attachment: 0, name: "SXT-003_02.jpg" },
          { role: "media", position: 0, source: "file", mediaRef: null, fileId: 11, attachment: 0, name: "SXT-003_01.jpg" },
          { role: "media", position: 2, source: "file", mediaRef: null, fileId: 13, attachment: 0, name: null },
        ],
      },
    };
    expect(parseHubDraftFile(JSON.stringify(answer), [])).toEqual({
      kind: "vault_album", text: "SXT-003",
      media: [{ source: "file", fileId: 11, name: "SXT-003_01.jpg" }, { source: "file", fileId: 12, name: "SXT-003_02.jpg" }, { source: "file", fileId: 13 }],
      previews: [],
    });
  });
});
