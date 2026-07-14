import { describe, expect, it } from "vitest";

import {
  adminAiPersonaCreateBodySchema,
  adminAiPersonaParamsSchema,
  aiPersonaCatalogResponseSchema,
  aiPersonaUpsertBodySchema,
  routeSchemas,
} from "@agency_hub_core/contracts";

describe("AI persona contracts", () => {
  it("declares metadata catalog auth separately from owner full-text administration", () => {
    expect(routeSchemas.aiPersonaCatalog.auth).toEqual({ kind: "apiKey" });
    expect(routeSchemas.adminAiPersonasList.auth).toEqual({ kind: "owner-session" });
    expect(routeSchemas.adminAiPersonaCreate.auth).toEqual({ kind: "owner-session" });
    expect(routeSchemas.adminAiPersonaUpdate.auth).toEqual({ kind: "owner-session" });
    expect(routeSchemas.adminAiPersonaArchive.auth).toEqual({ kind: "owner-session" });
    expect(routeSchemas).not.toHaveProperty("aiPersonaStates");
  });

  it("publishes persona-definition conflicts on the feature route", () => {
    expect(routeSchemas.aiFeatureStream.response).toHaveProperty("409");
  });

  it("cannot represent full prompt text in a parsed catalog response", () => {
    const parsed = aiPersonaCatalogResponseSchema.parse({
      personas: [{
        key: "custom:milly",
        displayName: "Milly",
        version: 7,
        definitionId: "v1:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
        status: "active",
        systemBlock: "must not survive response parsing",
      }],
    });
    expect(parsed).toEqual({
      personas: [{
        key: "custom:milly",
        displayName: "Milly",
        version: 7,
        definitionId: "v1:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
        status: "active",
      }],
    });
  });

  it("preserves owner-authored system prompt bytes while rejecting whitespace-only text", () => {
    const systemBlock = "\n  exact leading bytes\ntrailing bytes\n\n";
    const parsed = adminAiPersonaCreateBodySchema.parse({
      key: " custom:milly ",
      displayName: " Milly ",
      systemBlock,
    });
    expect(parsed).toEqual({
      key: "custom:milly",
      displayName: "Milly",
      systemBlock,
    });
    expect(adminAiPersonaCreateBodySchema.safeParse({
      key: "custom:blank",
      displayName: "Blank",
      systemBlock: " \n\t ",
    }).success).toBe(false);
  });

  it("keeps existing legacy persona keys exact on owner mutation paths", () => {
    expect(adminAiPersonaParamsSchema.parse({ key: " legacy.persona " })).toEqual({
      key: " legacy.persona ",
    });
    expect(adminAiPersonaCreateBodySchema.safeParse({
      key: "legacy.persona",
      displayName: "Legacy",
      systemBlock: "prompt",
    }).success).toBe(false);
  });

  it("keeps the shipped omitted-version legacy write body valid", () => {
    expect(aiPersonaUpsertBodySchema.safeParse({
      displayName: "Legacy",
      systemBlock: "legacy prompt",
    }).success).toBe(true);
  });
});
