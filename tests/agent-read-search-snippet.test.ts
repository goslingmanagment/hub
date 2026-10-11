import { describe, expect, it } from "vitest";

import { agentSearchLocatorSchema } from "@agency_hub_core/contracts";
import { AGENT_SEARCH_SNIPPET_MAX_LENGTH, searchAgentArchive } from "@agency_hub_core/db";
import { countLoneSurrogatesDeep } from "@agency_hub_core/shared";

// Prod, 2026-10-11: `hub search --snippet` answered 500 "Response validation
// failed" for `dress`, `bra`, `wearing` and `outfit` on one page, and worked for
// dozens of other words. Each failing query had exactly one hit whose snippet was
// a full 300-CHARACTER window holding an emoji: 302-303 UTF-16 code units against
// a contract cap of 300. One row took the whole answer down.
//
// The window is cut by Postgres, so a stub connection that hands back what
// Postgres hands back exercises the real mapping.

const input: Parameters<typeof searchAgentArchive>[1] = {
  pageIds: [1],
  query: "dress",
  from: new Date("2026-08-15T00:00:00Z"),
  to: new Date("2026-10-12T00:00:00Z"),
  includeSnippet: true,
  limit: 100,
};

function stubDb(snippets: Array<string | null>) {
  return {
    execute: async () => ({
      rows: snippets.map((snippet, index) => ({
        label: "ari-1",
        platform: "fansly",
        conversation_ref: "810272281019305984",
        message_ref: `m-${index}`,
        occurred_at: new Date("2026-09-01T10:00:00Z"),
        sender_role: "fan",
        is_sent_by_me: false,
        deleted_at: null,
        rank: 0.06,
        snippet,
      })),
    }),
  } as unknown as Parameters<typeof searchAgentArchive>[0];
}

/** What `substring(text_plain from … for 300)` returns: 300 characters. */
function windowOf(text: string): string {
  return [...text].slice(0, AGENT_SEARCH_SNIPPET_MAX_LENGTH).join("");
}

const snippetSchema = agentSearchLocatorSchema.shape.snippet;

describe("#7 search: a snippet fits the contract whatever the window holds", () => {
  it("a full window with emoji is cut to the cap instead of failing the response", async () => {
    const window = windowOf(`I love that dress 😍🔥 ${"so much ".repeat(40)}`);
    // The shape of the production rows: 300 characters, more than 300 code units.
    expect([...window]).toHaveLength(300);
    expect(window.length).toBe(302);
    expect(snippetSchema.safeParse(window).success).toBe(false);

    const { rows } = await searchAgentArchive(stubDb([window, "which dress do you like"]), input);

    expect(rows.map((row) => row.messageRef)).toEqual(["m-0", "m-1"]);
    expect(rows[0]!.snippet).toBe(window.slice(0, 300));
    expect(rows[0]!.snippet).toContain("dress 😍🔥");
    expect(rows[1]!.snippet).toBe("which dress do you like");
    for (const row of rows) {
      expect(snippetSchema.safeParse(row.snippet).success).toBe(true);
    }
  });

  it("the cut never leaves half an emoji at the boundary", async () => {
    // 297 letters and three emoji: 300 characters, 303 code units. Code unit 300
    // is the first half of the second emoji, so a plain slice(0, 300) ends on a
    // lone surrogate, which JSON and Postgres jsonb both mangle or refuse.
    const window = windowOf(`${"a".repeat(297)}😍😍😍`);
    expect(window.length).toBe(303);
    expect(countLoneSurrogatesDeep(window.slice(0, 300))).toBe(1);

    const { rows } = await searchAgentArchive(stubDb([window]), input);

    expect(rows[0]!.snippet).toBe(`${"a".repeat(297)}😍`);
    expect(countLoneSurrogatesDeep(rows[0]!.snippet)).toBe(0);
    expect(snippetSchema.safeParse(rows[0]!.snippet).success).toBe(true);
  });

  it("a short snippet and a withheld one pass through untouched", async () => {
    const { rows } = await searchAgentArchive(stubDb(["nice dress 😍", null]), input);
    expect(rows.map((row) => row.snippet)).toEqual(["nice dress 😍", null]);
  });
});
