import { describe, expect, it } from "vitest";

import {
  buildFanslyPublicWireRequest,
  buildFanslyWireRequest,
  FANSLY_PUBLIC_ACCOUNT_LOOKUP_KIND,
  FANSLY_PUBLIC_WIRE_SPECS,
  FANSLY_SESSION_HEADER_NAMES,
  FANSLY_WIRE_IDS,
  FANSLY_WIRE_SPECS,
  FanslyCredentialsRefusedError,
  fanslyPublicWireSpec,
  fanslyWireSpec,
  isFanslyWireId,
} from "@agency_hub_core/fansly";

// Arena "vanished chat" R5 (plan §7): the session-less request of the public
// account reader. Its spec is typed `credentials: "none"`, it lives apart from
// every page's route, and its builder takes no session and no cookie and
// refuses — before anything is built, so nothing can be journaled or sent — a
// spec that carries a session. The page's builder refuses it in turn.

const BASE_URL = "https://apiv3.fansly.example/api/v1";
const SPEC = fanslyPublicWireSpec("accounts.public_by_ids");
const IDS = ["290458453288165376", "955637964849827840"];

describe("the credentials of a spec", () => {
  it("every page route carries the page's session; the public route carries none and is no page route", () => {
    for (const id of FANSLY_WIRE_IDS) {
      expect(FANSLY_WIRE_SPECS[id].credentials, id).toBe("session");
    }
    expect(Object.keys(FANSLY_PUBLIC_WIRE_SPECS)).toEqual(["accounts.public_by_ids"]);
    expect(SPEC.credentials).toBe("none");
    expect(SPEC.host).toBe("api");
    expect(SPEC.kind).toBe(FANSLY_PUBLIC_ACCOUNT_LOOKUP_KIND);
    expect(FANSLY_PUBLIC_ACCOUNT_LOOKUP_KIND).toBe("account_lookup_public");
    // No page's actor, plan or probe can name it.
    expect(isFanslyWireId("accounts.public_by_ids")).toBe(false);
    expect(FANSLY_WIRE_IDS).not.toContain("accounts.public_by_ids");
  });
});

describe("buildFanslyPublicWireRequest", () => {
  it("builds the lookup the way a logged-out browser asks: the ids, ngsw-bypass last, no session header at all", () => {
    const request = buildFanslyPublicWireRequest(SPEC, { ids: IDS }, { baseUrl: BASE_URL, timeoutMs: 20_000 });
    expect(request).toMatchObject({ spec: "accounts.public_by_ids", credentials: "none", timeoutMs: 20_000 });
    expect(request.url).toBe(`${BASE_URL}/account?ids=${IDS.join(",")}&ngsw-bypass=true`);
    expect(Object.keys(request.headers)).toEqual([
      "user-agent", "accept", "accept-language", "accept-encoding", "referer",
      "origin", "dnt", "sec-gpc", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
    ]);
    for (const name of Object.keys(request.headers)) {
      expect(FANSLY_SESSION_HEADER_NAMES.has(name), name).toBe(false);
      expect(name.startsWith("fansly-"), name).toBe(false);
    }
    expect(JSON.stringify(request)).not.toMatch(/authorization|cookie|session/i);
  });

  it("refuses a spec that carries a session before anything is built", () => {
    const pageSpec = fanslyWireSpec("accounts.by_ids");
    expect(() => buildFanslyPublicWireRequest(pageSpec as never, { ids: IDS }, { baseUrl: BASE_URL, timeoutMs: 20_000 }))
      .toThrow(FanslyCredentialsRefusedError);
    expect(() => buildFanslyPublicWireRequest(pageSpec as never, { ids: IDS }, { baseUrl: BASE_URL, timeoutMs: 20_000 }))
      .toThrow(/public request builder refuses accounts\.by_ids: the spec is not session-less/);
    // A copy that claims `none` is not one of the public routes either.
    expect(() => buildFanslyPublicWireRequest({ ...SPEC }, { ids: IDS }, { baseUrl: BASE_URL, timeoutMs: 20_000 }))
      .toThrow(/not a route of FANSLY_PUBLIC_WIRE_SPECS/);
  });

  it("takes no session and no cookie: an input that carries one is refused", () => {
    for (const extra of [
      { session: { authorization: "token" } },
      { cookie: "fansly_session=1" },
      { cookies: ["a=b"] },
      { authorization: "token" },
      { headers: { authorization: "token" } },
    ]) {
      const input = { baseUrl: BASE_URL, timeoutMs: 20_000, ...extra };
      expect(() => buildFanslyPublicWireRequest(SPEC, { ids: IDS }, input as never), JSON.stringify(extra))
        .toThrow(FanslyCredentialsRefusedError);
    }
  });

  it("asks for 1–100 distinct Fansly ids and nothing else", () => {
    const build = (ids: string[]) => buildFanslyPublicWireRequest(SPEC, { ids }, { baseUrl: BASE_URL, timeoutMs: 20_000 });
    expect(() => build([])).toThrow(/1–100 ids/);
    const hundred = Array.from({ length: 100 }, (_, index) => String(400_000_000_000_000_000n + BigInt(index)));
    expect(new URL(build(hundred).url).searchParams.get("ids")!.split(",")).toHaveLength(100);
    expect(() => build([...hundred, "1"])).toThrow(/1–100 ids \(got 101\)/);
    expect(() => build(["12", "12"])).toThrow(/each id once/);
    for (const bad of ["", "abc", "1,2", "-1", " 1"]) {
      expect(() => build([bad]), bad).toThrow(/Fansly account ids/);
    }
    expect(() => buildFanslyPublicWireRequest(SPEC, { ids: IDS }, { baseUrl: BASE_URL, timeoutMs: 0 })).toThrow(RangeError);
  });
});

describe("the page builder", () => {
  it("refuses the session-less route before anything is built", () => {
    expect(() => buildFanslyWireRequest("accounts.public_by_ids" as never, { ids: IDS } as never, {
      baseUrl: BASE_URL,
      session: { authorization: "token" },
      timeoutMs: 20_000,
    })).toThrow(FanslyCredentialsRefusedError);
    // Its own route still builds, with the session.
    const own = buildFanslyWireRequest("accounts.by_ids", { ids: IDS }, {
      baseUrl: BASE_URL,
      session: { authorization: "token" },
      timeoutMs: 20_000,
    });
    expect(own.headers.authorization).toBe("token");
  });
});
