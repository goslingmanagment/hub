import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { publicationContentSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel } from "@agency_hub_core/db";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { SESSION_COOKIE_NAME, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createContentopsProbe } from "../apps/runtime/src/services/content-screens-moved.ts";
import { createPublicationDraft } from "../apps/runtime/src/services/publications.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { seedSandbox } from "../apps/runtime/src/services/sandbox/seed.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// «Публикации» and «Статистика → Контент» are ContentOps' screens (products package C2). Hub's server answers every
// address of them before any page: the owner goes on to ContentOps' sign-in by Hub with the model of the post or the
// page; the test team's owner, who has no ContentOps, reads where the screens are; when ContentOps does not answer,
// the person reads that, not a browser's error. Hub's own links (matters, the console) use its hop `/contentops/…`.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const CONTENTOPS = "https://contentops.gosling-agency.ru";
const PASSWORDS = { SANDBOX_PASSWORD_T_OWNER: "sandbox-owner-1" };

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let up = true;
const asked: string[] = [];
let owner = "";
let testOwner = "";
let postId = 0;

async function signIn(username: string, password: string): Promise<string> {
  const login = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(login.statusCode, login.body).toBe(200);
  return login.cookies.find((one) => one.name === SESSION_COOKIE_NAME)!.value;
}

const open = (url: string, session?: string) =>
  server!.inject({ method: "GET", url, ...(session ? { cookies: { [SESSION_COOKIE_NAME]: session } } : {}) });

/** Where ContentOps' sign-in by Hub leads after it: the screen's entry there. */
function nextOf(location: string | undefined): string {
  const url = new URL(location ?? "");
  expect(`${url.origin}${url.pathname}`).toBe(`${CONTENTOPS}/auth/hub/start`);
  return url.searchParams.get("next")!;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  // ContentOps' `/healthz`, faked: no request leaves the test. Asked fresh each time (no cache between cases).
  let clock = 0;
  app.contentopsProbe = createContentopsProbe({
    now: () => (clock += 60_000),
    fetch: (async (url: string) => {
      asked.push(String(url));
      if (!up) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  });
  await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
  const mia = await createModel(app.db, { slug: "Mia", name: "Mia" });
  const page = (await createFanslyPage(app.db, { modelId: mia!.id, label: "mia-1" }))!.id;
  const made = await createPublicationDraft(app.db, {
    pageId: page, author: { kind: "human", userId: await fixtureUserId(app, "boss") }, idempotencyKey: null, now: new Date(),
    body: publicationContentSchema.parse({ kind: "subscriber_post", text: "x", media: [{ source: "vault", mediaRef: "mia-1-m1" }], publishAt: new Date(Date.now() + 86_400_000).toISOString() }),
  });
  postId = made.id;
  await seedSandbox(app, { scenarios: [], env: PASSWORDS });
  server = await buildApiServer(app);
  await server.ready();
  owner = await signIn("boss", "boss-password-for-tests");
  testOwner = await signIn("t-owner", PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
}, 240_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("Hub's content screens moved to ContentOps", () => {
  it("sends the owner on with the page's model and what the address carried", async (context) => {
    if (!testDb) return context.skip();
    up = true;
    const response = await open("/content/publications?page=mia-1&status=draft&window=all", owner);
    expect(response.statusCode).toBe(302);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(nextOf(response.headers.location as string)).toBe("/hub/publications?model=mia&page=mia-1&status=draft&window=all");
    const stats = await open("/stats/content?page=mia-1&period=30d", owner);
    expect(nextOf(stats.headers.location as string)).toBe("/hub/stats?model=mia&page=mia-1&days=30");
    expect(asked.every((url) => url === `${CONTENTOPS}/healthz`)).toBe(true);
  });

  it("finds a post's model for a signed-in person, and opens its card", async (context) => {
    if (!testDb || postId === 0) return context.skip();
    up = true;
    const response = await open(`/contentops/publications?publication=${postId}`, owner);
    expect(nextOf(response.headers.location as string)).toBe(`/hub/publications?model=mia&post=${postId}`);
    // Nobody signed in: no post's model; the page's label still names one.
    const anonymous = await open(`/contentops/publications?publication=${postId}`);
    expect(nextOf(anonymous.headers.location as string)).toBe(`/hub/publications?post=${postId}`);
  });

  it("tells the test team's owner where the screens are, never a redirect", async (context) => {
    if (!testDb) return context.skip();
    up = true;
    for (const url of ["/content/publications", "/stats/content", "/contentops/stats?page=test-1"]) {
      const response = await open(url, testOwner);
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("Контент теперь в ContentOps");
      expect(response.body).toContain("t-km");
    }
  });

  it("says ContentOps is not answering instead of sending the person to a browser's error", async (context) => {
    if (!testDb) return context.skip();
    up = false;
    const response = await open("/content/publications?page=mia-1", owner);
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("ContentOps сейчас недоступен");
    expect(response.body).toContain('href="/content/publications?page=mia-1"');
    up = true;
  });

  it("leaves Hub's own screens and the API alone", async (context) => {
    if (!testDb) return context.skip();
    for (const url of ["/stats", "/stats?tab=audience", "/stats/audience", "/content/mass-messages", "/api/v1/auth/me"]) {
      const response = await open(url, owner);
      expect(String(response.headers.location ?? ""), url).not.toContain("contentops");
    }
  });
});
