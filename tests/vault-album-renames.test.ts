import { describe, expect, it } from "vitest";

import type { FanslyWriteCommandRecord, PageFanslyVaultAlbum } from "@agency_hub_core/db";
import { buildFanslyWireBody } from "@agency_hub_core/fansly";

import { decideVaultAlbumRename, findRenameAlbum } from "../apps/runtime/src/services/vault-album-renames.ts";
import { readWriteAnswer } from "../apps/runtime/src/sync/fansly/publish/answers.ts";
import { deriveFanslyAlbumEditCommand } from "../apps/runtime/src/sync/fansly/publish/derive.ts";

// An agent's rename of a Fansly vault album (0451): which album a rename names,
// when it is refused or answered from the command Hub holds, and the request
// and answer as the site's «Edit Album Details» showed them live (2026-11-27).

const LISTED = new Date("2026-11-27T10:00:00Z");

function album(albumRef: string, title: string | null, overrides: Partial<PageFanslyVaultAlbum> = {}): PageFanslyVaultAlbum {
  return { albumRef, title, description: "", lastObservedAt: LISTED, ...overrides };
}

function edit(overrides: Partial<FanslyWriteCommandRecord> & { title?: string } = {}): FanslyWriteCommandRecord {
  const { title = "PPV-024 Белое бельё", ...rest } = overrides;
  return {
    id: 500, pageId: 7, dispatchId: null, publicationId: null, step: "album_edit", item: "", priority: "background",
    notBefore: LISTED, notAfter: null, state: "queued", stateReason: null, workId: 1, attemptId: null, notSentCount: 0,
    request: null, requestFingerprint: null, result: null, httpStatus: null, observationId: null,
    createdAt: new Date("2026-11-27T11:00:00Z"), admittedAt: null, settledAt: null, postRef: null,
    albumEdit: { albumRef: "11", title, description: "" },
    ...rest,
  };
}

const ALBUMS = [
  album("11", "PPV-018 Белое бельё"),
  album("12", " SEXTING 1 "),
  album("13", "SEXTING 1"),
  album("14", "PPV-030 Душ"),
];

describe("which album a rename names", () => {
  it("by its exact title, the spaces at the edges aside; none or several are refused", () => {
    expect(findRenameAlbum(ALBUMS, { title: "PPV-018 Белое бельё" })).toMatchObject({ ok: true, album: { albumRef: "11" } });
    expect(findRenameAlbum(ALBUMS, { title: "PPV-018" })).toEqual({ ok: false, reason: "album_not_found", albums: null });
    const twins = findRenameAlbum(ALBUMS, { title: "SEXTING 1" });
    expect(twins).toMatchObject({ ok: false, reason: "album_title_ambiguous" });
    expect(twins.ok ? [] : twins.albums?.map((one) => one.albumRef)).toEqual(["12", "13"]);
  });

  it("by its id only among the page's albums", () => {
    expect(findRenameAlbum(ALBUMS, { albumRef: "13" })).toMatchObject({ ok: true, album: { albumRef: "13" } });
    expect(findRenameAlbum(ALBUMS, { albumRef: "99" })).toEqual({ ok: false, reason: "album_not_found", albums: null });
  });
});

describe("whether a rename goes", () => {
  const target = ALBUMS[0]!;
  const decide = (title: string, commands: FanslyWriteCommandRecord[] = [], one = target) =>
    decideVaultAlbumRename({ album: one, albums: ALBUMS, commands, title });

  it("goes to a title no album of the page holds", () => {
    expect(decide("PPV-024 Белое бельё")).toEqual({ kind: "go" });
  });

  it("refuses the album's own title and another album's", () => {
    expect(decide("PPV-018 Белое бельё")).toEqual({ kind: "refused", reason: "title_unchanged" });
    expect(decide("SEXTING 1")).toEqual({ kind: "refused", reason: "title_taken" });
  });

  it("answers the same rename under way from its command, and refuses another beside it", () => {
    const queued = edit();
    expect(decide("PPV-024 Белое бельё", [queued])).toEqual({ kind: "repeat", command: queued });
    expect(decide("PPV-025 Белое бельё", [queued])).toEqual({ kind: "refused", reason: "rename_in_progress" });
    // A refused one never went: it holds nothing back.
    expect(decide("PPV-025 Белое бельё", [edit({ state: "refused", stateReason: "publishing_off" })])).toEqual({ kind: "go" });
  });

  it("never sends again after an unknown end until a listing of the albums came after it", () => {
    const unknown = edit({ state: "unknown", stateReason: "no_answer:timeout", settledAt: new Date("2026-11-27T11:01:00Z") });
    expect(decide("PPV-024 Белое бельё", [unknown])).toEqual({ kind: "repeat", command: unknown });
    expect(decide("PPV-025 Белое бельё", [unknown])).toEqual({ kind: "refused", reason: "previous_rename_unknown" });
    const listedSince = album("11", "PPV-018 Белое бельё", { lastObservedAt: new Date("2026-11-27T12:00:00Z") });
    expect(decide("PPV-024 Белое бельё", [unknown], listedSince)).toEqual({ kind: "go" });
  });

  it("answers a rename Fansly confirmed, the album holding its title, from its command", () => {
    const answered = edit({ state: "answered", settledAt: new Date("2026-11-27T11:01:00Z") });
    const renamed = album("11", "PPV-024 Белое бельё");
    expect(decide("PPV-024 Белое бельё", [answered], renamed)).toEqual({ kind: "repeat", command: answered });
  });
});

describe("the request and its answer", () => {
  it("sends the album, the new title and the description as it stands (one left out is cleared)", () => {
    expect(JSON.parse(buildFanslyWireBody("publish.vault_album_edit", { albumId: "11", title: "PPV-024", description: "" })!))
      .toEqual({ id: "11", title: "PPV-024", description: "" });
    expect(() => buildFanslyWireBody("publish.vault_album_edit", { albumId: "11", title: "x".repeat(121), description: "" })).toThrow(RangeError);
    expect(() => buildFanslyWireBody("publish.vault_album_edit", { albumId: "11", title: "  ", description: "" })).toThrow(RangeError);
  });

  it("is derived from the command's own row, and only for an album_edit", () => {
    const derived = deriveFanslyAlbumEditCommand({ command: edit({ albumEdit: { albumRef: "11", title: "PPV-024", description: "keep me" } }) });
    expect(derived).toMatchObject({ ok: true, request: { spec: "publish.vault_album_edit", params: { albumId: "11", title: "PPV-024", description: "keep me" } } });
    expect(deriveFanslyAlbumEditCommand({ command: edit({ albumEdit: null }) })).toEqual({ ok: false, reason: "no_album" });
    expect(deriveFanslyAlbumEditCommand({ command: edit({ step: "post_delete" }) })).toEqual({ ok: false, reason: "step_needs_publication" });
  });

  it("counts as renamed only the asked album under the asked title", () => {
    const params = { albumId: "11", title: "PPV-024", description: "" };
    const answer = { id: "11", accountId: "1", pos: 4, title: "PPV-024", description: "", type: null, status: 0, version: 2 };
    expect(readWriteAnswer("album_edit", answer, params)).toEqual({ ok: true, result: { albumId: "11", title: "PPV-024", description: "" } });
    expect(readWriteAnswer("album_edit", { ...answer, title: "PPV-018" }, params)).toEqual({ ok: false, reason: "answer_title_differs" });
    expect(readWriteAnswer("album_edit", { ...answer, id: "12" }, params)).toEqual({ ok: false, reason: "answer_album_differs" });
  });
});
