// The capture lane stamps each observation's producer from x-client-version.
// The chat-extension journals as its own producer; the desktop, its harvest
// uploader and the Fansly extension keep the stamps they already write.

import { describe, expect, it } from "vitest";

import {
  ingestProducerForClientVersion,
  isHarvestClientVersion,
  isHarvestProducer,
} from "../apps/runtime/src/services/ingest-observations.ts";

describe("ingest producer for x-client-version", () => {
  it.each([
    { style: "desktop (bare version)", header: "0.1.64", producer: "desktop@0.1.64", harvest: false },
    { style: "desktop harvest", header: "harvest-0.1.29", producer: "desktop-harvest@0.1.29", harvest: true },
    {
      style: "Fansly extension",
      header: "chatgoose-extension/2.7.1",
      producer: "desktop@chatgoose-extension/2.7.1",
      harvest: false,
    },
    { style: "chat-extension", header: "chat-extension/0.1.0", producer: "chat-extension@0.1.0", harvest: false },
  ])("$style: $header → $producer", ({ header, producer, harvest }) => {
    expect(ingestProducerForClientVersion(header)).toBe(producer);
    expect(isHarvestProducer(producer)).toBe(harvest);
    expect(isHarvestClientVersion(header)).toBe(harvest);
  });

  it("keeps a pre-release chat-extension version verbatim", () => {
    expect(ingestProducerForClientVersion("chat-extension/1.2.0-beta.3"))
      .toBe("chat-extension@1.2.0-beta.3");
  });

  it("stamps desktop@ when the header only resembles the chat-extension style", () => {
    expect(ingestProducerForClientVersion("chat-extension/")).toBe("desktop@chat-extension/");
    expect(ingestProducerForClientVersion("chat-extension")).toBe("desktop@chat-extension");
    expect(ingestProducerForClientVersion("my-chat-extension/0.1.0")).toBe("desktop@my-chat-extension/0.1.0");
  });
});
