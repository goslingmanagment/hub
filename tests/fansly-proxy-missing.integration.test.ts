// W3.1 (B6+A35, decision #124): Fansly egress fails CLOSED. Resolving a
// proxyless Fansly page context refuses with a typed error AND opens a
// proxy_missing incident; proxied Fansly pages and OnlyFans pages (vendor-side
// egress) are unaffected; assigning a proxy + a successful chunk resolves it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const telegramMocks = vi.hoisted(() => ({
  sendTelegramMessage: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/telegram.ts", () => ({
  sendTelegramMessage: telegramMocks.sendTelegramMessage,
}));

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  getNotificationIncidentByKey,
  listDeliveryAttempts,
  storeFanslySession,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { ProxyMissingError } from "../apps/runtime/src/services/errors.ts";
import { resolveSyncChunkRecoveryIncidents } from "../apps/runtime/src/services/notification-incidents.ts";
import { resolvePageContext, saveProxy } from "../apps/runtime/src/services/page-context.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;

function encryptedFanslySession() {
  return JSON.stringify(encryptJson({
    platform: "fansly",
    session: {
      authorization: "token",
    },
  }, Buffer.alloc(32, 7), 1));
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  telegramMocks.sendTelegramMessage.mockReset();
  telegramMocks.sendTelegramMessage.mockResolvedValue({
    status: "sent",
    chatId: "6065935464",
    messageId: 1,
  });
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

describe("Fansly fail-closed egress (W3.1)", () => {
  it("refuses a proxyless Fansly page with the typed error and one deduped proxy_missing incident", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, {
      slug: "fail-closed-model",
      name: "Fail Closed Model",
    }))!;
    const page = (await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "fail-closed-page",
    }))!;
    await storeFanslySession(testDb.db, page.id, encryptedFanslySession(), 1);

    const app = createTestAppContext(testDb);

    await expect(resolvePageContext(app, page.label))
      .rejects.toBeInstanceOf(ProxyMissingError);
    await expect(resolvePageContext(app, page.label))
      .rejects.toThrow(/fail-closed/);

    const incident = await getNotificationIncidentByKey(
      testDb.db,
      `proxy_missing:${page.id}`,
    );
    expect(incident).toEqual(expect.objectContaining({
      kind: "proxy_missing",
      status: "open",
      errorCode: "proxy_missing",
    }));

    // The second refusal deduped into the existing incident. Nothing here
    // sends: paging is the sweep's (Decision 381), so no delivery attempt
    // exists yet either.
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();
    const attempts = await listDeliveryAttempts(testDb.db, {
      kind: ["incident_opened"],
    });
    expect(attempts).toHaveLength(0);
  });

  it("resolves normally once a proxy is assigned and a successful chunk closes the incident", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, {
      slug: "repaired-model",
      name: "Repaired Model",
    }))!;
    const page = (await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "repaired-page",
    }))!;
    await storeFanslySession(testDb.db, page.id, encryptedFanslySession(), 1);

    const app = createTestAppContext(testDb);

    await expect(resolvePageContext(app, page.label))
      .rejects.toBeInstanceOf(ProxyMissingError);

    await saveProxy(app, page.id, { url: "socks5://127.0.0.1:1080" });

    const resolved = await resolvePageContext(app, page.label);
    expect(resolved.platform).toBe("fansly");
    expect(resolved.proxy).toEqual(expect.objectContaining({
      url: "socks5://127.0.0.1:1080",
    }));
    expect(resolved.egressKey).toBe("socks5://127.0.0.1:1080");

    // A successful chunk after the repair resolves the incident.
    await resolveSyncChunkRecoveryIncidents(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      stream: "light",
      providerRecoveredAt: new Date(),
    });
    expect(await getNotificationIncidentByKey(
      testDb.db,
      `proxy_missing:${page.id}`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
  });

  it("leaves proxyless OnlyFans pages untouched (vendor-side egress)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, {
      slug: "of-direct-model",
      name: "OF Direct Model",
    }))!;
    const page = (await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "of-direct-page",
    }))!;

    const app = createTestAppContext(testDb);

    const resolved = await resolvePageContext(app, page.label);
    expect(resolved.platform).toBe("onlyfans");
    expect(resolved.proxy).toBeNull();
    expect(resolved.egressKey).toBe("direct");

    expect(await getNotificationIncidentByKey(
      testDb.db,
      `proxy_missing:${page.id}`,
    )).toBeNull();
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();
  });
});
