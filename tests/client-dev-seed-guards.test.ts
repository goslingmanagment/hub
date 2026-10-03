import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CONFIG_DESCRIPTORS, loadConfig } from "@agency_hub_core/shared";

import {
  DEV_SEED_BLANKED_ENV,
  DEV_SEED_DATABASE_HOSTS,
  DEV_SEED_FANS,
  DEV_SEED_PAGES,
  DevSeedRefusedError,
  assertLocalDevDatabaseTarget,
  assertSeedableDatabase,
  blankVendorCredentials,
} from "../scripts/dev-seed-client.ts";

// The dev seed writes users, pages and money rows. These guards are all that
// stands between it and a database that is not a local scratch hub.

const local = "postgres://postgres:postgres@localhost:5432/agency_hub_core";

function refusal(run: () => void): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DevSeedRefusedError);
    return (error as Error).message;
  }
  throw new Error("expected the guard to refuse");
}

describe("dev seed target guard", () => {
  it.each([
    "postgres://postgres:postgres@localhost:5432/agency_hub_core",
    "postgresql://postgres:postgres@127.0.0.1:55432/agency_hub_core",
    "postgres://postgres:postgres@[::1]:5432/agency_hub_core",
    "postgres://postgres:postgres@LOCALHOST/agency_hub_core",
    // docker-compose.yml's service, when the seed runs inside the dev network.
    "postgres://postgres:postgres@postgres:5432/agency_hub_core",
  ])("accepts a local dev database: %s", (databaseUrl) => {
    expect(() => assertLocalDevDatabaseTarget({ databaseUrl, nodeEnv: undefined })).not.toThrow();
    expect(() => assertLocalDevDatabaseTarget({ databaseUrl, nodeEnv: "development" })).not.toThrow();
  });

  it.each([
    ["a remote host", "postgres://postgres:secret@gosling-agency.ru:5432/agency_hub_core", /host "gosling-agency.ru"/],
    ["a server IP", "postgres://postgres:secret@45.8.230.111:5432/agency_hub_core", /host "45.8.230.111"/],
    ["a private-network IP", "postgres://postgres:secret@10.0.0.5:5432/agency_hub_core", /host "10.0.0.5"/],
    ["a lookalike host", "postgres://postgres:secret@localhost.example.com/agency_hub_core", /host "localhost.example.com"/],
    ["a ?host= override", `${local}?host=db.internal`, /overrides its host/],
    ["a ?hostaddr= override", `${local}?hostaddr=10.0.0.5`, /overrides its host/],
    ["a socket-only URL", "postgres:///agency_hub_core?host=/var/run/postgresql", /overrides its host/],
    ["another scheme", "mysql://root@localhost/agency_hub_core", /scheme "mysql:"/],
    ["a libpq keyword string", "host=localhost dbname=agency_hub_core", /not a postgres:\/\/ URL/],
  ])("refuses %s", (_name, databaseUrl, message) => {
    expect(refusal(() => assertLocalDevDatabaseTarget({ databaseUrl, nodeEnv: undefined }))).toMatch(message);
  });

  it("refuses a production process even against localhost", () => {
    for (const nodeEnv of ["production", "Production", " production "]) {
      expect(refusal(() => assertLocalDevDatabaseTarget({ databaseUrl: local, nodeEnv }))).toMatch(/NODE_ENV is production/);
    }
  });

  it("names the compose service docker-compose.yml actually defines", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const services = DEV_SEED_DATABASE_HOSTS.filter((host) => !["localhost", "127.0.0.1", "::1"].includes(host));
    expect(services).toEqual(["postgres"]);
    expect(compose).toMatch(/^ {2}postgres:\n/m);
    expect(compose).toContain("DATABASE_URL: postgres://postgres:postgres@postgres:5432/agency_hub_core");
  });
});

describe("dev seed database guard", () => {
  it("seeds a database that holds no pages, or only its own", () => {
    expect(() => assertSeedableDatabase({ foreignPageLabels: [], allowExistingPages: false })).not.toThrow();
  });

  it("refuses a database with pages it did not create, unless told otherwise", () => {
    const labels = ["lora-of", "lora-vip-of", "a", "b", "c", "d"];
    const message = refusal(() => assertSeedableDatabase({ foreignPageLabels: labels, allowExistingPages: false }));
    expect(message).toMatch(/holds 6 page\(s\) the dev seed did not create \(lora-of, lora-vip-of, a, b, c, …\)/);
    expect(message).toMatch(/--allow-existing-pages/);
    expect(() => assertSeedableDatabase({ foreignPageLabels: labels, allowExistingPages: true })).not.toThrow();
  });
});

describe("dev seed vendor credentials", () => {
  // Secrets the seed keeps: its own database and encryption key, an inbound
  // token, a chat id (not a credential), and the service egress proxy, which
  // nothing uses once the vendor keys are gone.
  const kept = [
    "DATABASE_URL", "APP_ENCRYPTION_KEY", "HEALTH_SYNC_MONITORING_TOKEN", "TELEGRAM_CHAT_ID",
    "SERVICE_EGRESS_PROXY_USERNAME", "SERVICE_EGRESS_PROXY_PASSWORD",
  ];

  it("blanks every other secret the config knows, so a new vendor key gets a decision here", () => {
    const secrets = CONFIG_DESCRIPTORS.filter((descriptor) => descriptor.kind === "secret")
      .map((descriptor) => descriptor.envName);
    expect([...DEV_SEED_BLANKED_ENV].sort()).toEqual(secrets.filter((name) => !kept.includes(name)).sort());
  });

  it("leaves the keys unset for the app context's config", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: local,
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      OFAPI_API_KEY: "ofapi-key",
      OFAPI_EXPECTED_TEAM_SLUG: "team",
      ANTHROPIC_API_KEY: "anthropic-key",
      ANTHROPIC_MEDIA_API_KEY: "anthropic-media-key",
      OPENROUTER_API_KEY: "openrouter-key",
      ELEVENLABS_API_KEY: "elevenlabs-key",
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_CHAT_ID: "1",
    };
    blankVendorCredentials(env);
    const config = loadConfig(env, { loadDotEnv: false });
    expect(config.ofapiApiKey).toBeNull();
    expect(config.anthropicApiKey).toBeNull();
    expect(config.anthropicMediaApiKey).toBeNull();
    expect(config.openrouterApiKey).toBeFalsy();
    expect(config.elevenLabsApiKey).toBeUndefined();
    expect(config.telegramBotToken).toBeNull();
    expect(config.databaseUrl).toBe(local);
  });
});

describe("dev seed fixtures", () => {
  it("never carry the real lora-of / lora-vip-of creator ids", () => {
    const ids = [
      ...Object.values(DEV_SEED_PAGES).map((page) => page.externalId),
      ...Object.values(DEV_SEED_FANS).map((fan) => fan.id),
    ];
    expect(ids).not.toContain("518588958");
    expect(ids).not.toContain("514788334");
    for (const id of ids) expect(id).toMatch(/^[1-9]\d{8}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
