import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FanslyAdapter } from "@agency_hub_core/fansly";

import {
  loadOnlyMonsterTokenBundleFromFile,
  loadSessionBundleFromFile,
} from "../apps/runtime/src/services/page-context.ts";

async function withSessionFile(
  body: Record<string, unknown>,
  run: (filePath: string) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "fansly-session-"));
  const filePath = path.join(dir, "session.json");

  try {
    await writeFile(filePath, JSON.stringify(body), "utf8");
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Fansly session files", () => {
  it("accepts authorization-only bundles", async () => {
    await withSessionFile({ authorization: "token" }, async (filePath) => {
      await expect(loadSessionBundleFromFile(filePath)).resolves.toEqual({
        authorization: "token",
        fanslyClientId: undefined,
        fanslyClientCheck: undefined,
        fanslySessionId: undefined,
      });
    });
  });

  it("treats null optional headers as missing", async () => {
    await withSessionFile(
      {
        authorization: "token",
        "fansly-client-id": null,
        fanslyClientCheck: "client-check",
      },
      async (filePath) => {
        await expect(loadSessionBundleFromFile(filePath)).resolves.toEqual({
          authorization: "token",
          fanslyClientId: undefined,
          fanslyClientCheck: "client-check",
          fanslySessionId: undefined,
        });
      },
    );
  });

  it("rejects non-string optional headers", async () => {
    await withSessionFile(
      {
        authorization: "token",
        "fansly-session-id": 123,
      },
      async (filePath) => {
        await expect(loadSessionBundleFromFile(filePath)).rejects.toThrow(
          'Session file field "fansly-session-id" must be a string when provided',
        );
      },
    );
  });
});

describe("Fansly adapter headers", () => {
  it("omits optional Fansly headers when values are missing", () => {
    const adapter = new FanslyAdapter({ baseUrl: "https://apiv3.fansly.com/api/v1" });
    const buildHeaders = (
      adapter as unknown as {
        buildHeaders: (session: {
          authorization: string;
          fanslyClientId?: string;
          fanslyClientCheck?: string;
          fanslySessionId?: string;
        }) => Record<string, string>;
      }
    ).buildHeaders.bind(adapter);

    const headers = buildHeaders({
      authorization: "token",
      fanslyClientId: "",
      fanslyClientCheck: undefined,
      fanslySessionId: "session-id",
    });

    expect(headers).toMatchObject({
      authorization: "token",
      "fansly-session-id": "session-id",
      accept: "application/json, text/plain, */*",
      referrer: "https://fansly.com/",
    });
    expect(headers["fansly-client-ts"]).toEqual(expect.any(String));
    expect(headers).not.toHaveProperty("fansly-client-id");
    expect(headers).not.toHaveProperty("fansly-client-check");
  });
});

describe("OnlyMonster token files", () => {
  it("accepts token-file aliases", async () => {
    await withSessionFile({ "x-om-auth-token": "om-token" }, async (filePath) => {
      await expect(loadOnlyMonsterTokenBundleFromFile(filePath)).resolves.toEqual({
        token: "om-token",
      });
    });
  });
});
