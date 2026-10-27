import { describe, expect, it } from "vitest";

import { blocklistHandleKey, parseBlocklistHandles } from "../apps/runtime/src/services/fansly-blocklist/handles.ts";

// FANSLY BLOCKLIST: which Fansly profiles a post of the group names. The
// posts below are the group's own (2026-10-27).

const handles = (text: string, urls: string[] = []) => parseBlocklistHandles(text, urls).map((one) => one.handle);

describe("parseBlocklistHandles", () => {
  it.each([
    ["https://fansly.com/Abyssal136/posts", ["Abyssal136"]],
    ["https://fansly.com/ElianOlvera\nлол", ["ElianOlvera"]],
    ["https://fansly.com/user676484410492592129", ["user676484410492592129"]],
    ["tw\n\nhttps://fansly.com/patapimbr", ["patapimbr"]],
    ["https://fansly.com/heelscuckyboy\n\nTW", ["heelscuckyboy"]],
    ["UPD: ✅заплатил\n\nкинул на 40 и пропал\n\nhttps://fansly.com/allalalala1", ["allalalala1"]],
    ["https://fansly.com/user870954213373399040\nDNP + TM", ["user870954213373399040"]],
    ["https://fansly.com/user959539180382199808/posts dnp tw", ["user959539180382199808"]],
    ["https://fansly.com/jcob4\n\nНаписал кучу фантазий, карту добавить не смог.", ["jcob4"]],
  ])("names the profile of %j", (text, expected) => {
    expect(handles(text)).toEqual(expected);
  });

  it("takes a link without a scheme, with www., a query, a fragment, /media, any case, a trailing dot or bracket", () => {
    expect(handles("fansly.com/plainone")).toEqual(["plainone"]);
    expect(handles("http://www.fansly.com/WwwOne/media")).toEqual(["WwwOne"]);
    expect(handles("HTTPS://FANSLY.COM/LoudOne?ref=abc#top")).toEqual(["LoudOne"]);
    expect(handles("he is fansly.com/dotted.")).toEqual(["dotted"]);
    expect(handles("(https://fansly.com/bracketed)")).toEqual(["bracketed"]);
    expect(handles("https://fansly.com/@atone")).toEqual(["atone"]);
    expect(handles("https://fansly.com/john.doe/posts")).toEqual(["john.doe"]);
    expect(handles("https://fansly.com/under_score-dash")).toEqual(["under_score-dash"]);
  });

  it("names every profile of a post once, by key, in the order it names them", () => {
    expect(handles("https://fansly.com/One\nhttps://fansly.com/two\nfansly.com/ONE/posts")).toEqual(["One", "two"]);
    expect(parseBlocklistHandles("x https://fansly.com/MixedCase")).toEqual([{ key: "mixedcase", handle: "MixedCase" }]);
  });

  it("reads the target of a text link too", () => {
    expect(handles("этот тип", ["https://fansly.com/HiddenOne/posts"])).toEqual(["HiddenOne"]);
    expect(handles("https://fansly.com/shown", ["https://fansly.com/Shown", "https://t.me/somewhere"])).toEqual(["shown"]);
  });

  it("names nobody for Fansly's own pages, another host, an address or no link", () => {
    expect(handles("https://fansly.com/post/752345234523452345")).toEqual([]);
    expect(handles("https://fansly.com/explore/tag/x https://fansly.com/messages https://fansly.com/settings")).toEqual([]);
    expect(handles("https://notfansly.com/someone and https://fansly.com.evil/x")).toEqual([]);
    expect(handles("mail me: someone@fansly.com/abc")).toEqual([]);
    expect(handles("https://fansly.com/")).toEqual([]);
    expect(handles("")).toEqual([]);
    expect(handles("просто текст без ссылок")).toEqual([]);
  });
});

describe("blocklistHandleKey", () => {
  it("lowercases a username, drops a leading @, refuses what no link could name", () => {
    expect(blocklistHandleKey("ElianOlvera")).toBe("elianolvera");
    expect(blocklistHandleKey(" @jcob4 ")).toBe("jcob4");
    expect(blocklistHandleKey("john.doe")).toBe("john.doe");
    expect(blocklistHandleKey("")).toBeNull();
    expect(blocklistHandleKey("has space")).toBeNull();
    expect(blocklistHandleKey("trailing.")).toBeNull();
    expect(blocklistHandleKey("posts")).toBeNull();
    expect(blocklistHandleKey("кириллица")).toBeNull();
  });
});
