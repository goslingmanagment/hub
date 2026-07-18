import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createModel, createFanslyPage, createOnlyFansPage } from "@agency_hub_core/db";

import {
  removeVoiceProfile,
  setVoiceProfile,
  showVoiceProfile,
} from "../apps/runtime/src/services/voice-profiles.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

async function createFanslyVoicePage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, { slug: `${label}-model`, name: `${label} model` });
  if (!model) {
    throw new Error("createModel returned no row");
  }
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label });
  if (!page) {
    throw new Error("createFanslyPage returned no row");
  }
  return page;
}

async function createOnlyFansVoicePage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, { slug: `${label}-model`, name: `${label} model` });
  if (!model) {
    throw new Error("createModel returned no row");
  }
  const page = await createOnlyFansPage(testDb.db, { modelId: model.id, label });
  if (!page) {
    throw new Error("createOnlyFansPage returned no row");
  }
  return page;
}

describe("voice-profiles service", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
  });

  it("round-trips set→show and bumps the version on a second set", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const app = { db: testDb.db };
    const page = await createFanslyVoicePage(testDb, "voice-set-show");

    // No binding yet.
    expect(await showVoiceProfile(app, page.label)).toBeNull();

    const first = await setVoiceProfile(app, page.label, {
      voiceId: "voice-1",
      stability: "natural",
    });
    expect(first.version).toBe(1);

    const afterFirst = await showVoiceProfile(app, page.label);
    expect(afterFirst?.voiceId).toBe("voice-1");
    expect(afterFirst?.version).toBe(1);
    // Defaults applied when the caller omits model/output-format.
    expect(afterFirst?.model).toBe("eleven_v3");
    expect(afterFirst?.outputFormat).toBe("mp3_44100_128");
    // The CLI default preset "natural" is resolved to its NUMBER before storage
    // (ElevenLabs voice_settings.stability is a number in [0, 1]).
    expect(afterFirst?.settings).toEqual({ stability: 0.5 });

    const second = await setVoiceProfile(app, page.label, {
      voiceId: "voice-2",
      model: "eleven_multilingual_v2",
      outputFormat: "mp3_22050_32",
    });
    expect(second.version).toBe(2);

    const afterSecond = await showVoiceProfile(app, page.label);
    expect(afterSecond?.voiceId).toBe("voice-2");
    expect(afterSecond?.version).toBe(2);
    expect(afterSecond?.model).toBe("eleven_multilingual_v2");
    expect(afterSecond?.outputFormat).toBe("mp3_22050_32");
    // No stability supplied → empty settings blob.
    expect(afterSecond?.settings).toEqual({});
  });

  it("clears an existing binding", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const app = { db: testDb.db };
    const page = await createFanslyVoicePage(testDb, "voice-clear");

    await setVoiceProfile(app, page.label, { voiceId: "voice-1" });
    expect(await showVoiceProfile(app, page.label)).not.toBeNull();

    await removeVoiceProfile(app, page.label);
    expect(await showVoiceProfile(app, page.label)).toBeNull();

    // Clearing an absent binding is a no-op, not an error.
    await expect(removeVoiceProfile(app, page.label)).resolves.toBeUndefined();
  });

  it("rejects a non-MP3 output-format (the audio route is audio/mpeg-only)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const app = { db: testDb.db };
    const page = await createFanslyVoicePage(testDb, "voice-format");

    // A valid ElevenLabs PCM format is still refused — the download route serves
    // audio/mpeg with nosniff, so only MP3 formats may be pinned.
    await expect(
      setVoiceProfile(app, page.label, { voiceId: "voice-1", outputFormat: "pcm_44100" }),
    ).rejects.toThrow(/mp3|not supported/i);
    // Nothing was persisted.
    expect(await showVoiceProfile(app, page.label)).toBeNull();

    // Every allowlisted MP3 format is accepted.
    const first = await setVoiceProfile(app, page.label, {
      voiceId: "voice-1",
      outputFormat: "mp3_44100_192",
    });
    expect(first.version).toBe(1);
    expect((await showVoiceProfile(app, page.label))?.outputFormat).toBe("mp3_44100_192");
  });

  it("maps stability presets and numeric strings to a stored number, rejecting the rest", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const app = { db: testDb.db };
    const page = await createFanslyVoicePage(testDb, "voice-stability");

    // Presets resolve to their numeric value (case-insensitive)…
    await setVoiceProfile(app, page.label, { voiceId: "v", stability: "Creative" });
    expect((await showVoiceProfile(app, page.label))?.settings).toEqual({ stability: 0.3 });
    await setVoiceProfile(app, page.label, { voiceId: "v", stability: "robust" });
    expect((await showVoiceProfile(app, page.label))?.settings).toEqual({ stability: 0.8 });

    // …a numeric string in range is parsed and stored as a number…
    await setVoiceProfile(app, page.label, { voiceId: "v", stability: "0.72" });
    expect((await showVoiceProfile(app, page.label))?.settings).toEqual({ stability: 0.72 });

    // …and anything else (unknown word, out-of-range number) is rejected.
    await expect(
      setVoiceProfile(app, page.label, { voiceId: "v", stability: "banana" }),
    ).rejects.toThrow(/stability .* invalid/i);
    await expect(
      setVoiceProfile(app, page.label, { voiceId: "v", stability: "1.5" }),
    ).rejects.toThrow(/stability .* invalid/i);

    // Object.prototype member names must NOT slip through the preset lookup: a
    // bare `STABILITY_PRESETS[key]` walks the prototype chain, so "constructor"
    // resolves to the inherited Object function and "__proto__" to the prototype
    // object — each `!== undefined` — and (before the own-property guard) would
    // be stored as a broken settings blob instead of raising BadRequest. The
    // lookup lower-cases first, so "toString" arrives as "tostring" (which is not
    // itself a prototype key, but is asserted for completeness).
    for (const key of ["constructor", "__proto__", "tostring"]) {
      await expect(
        setVoiceProfile(app, page.label, { voiceId: "v", stability: key }),
      ).rejects.toThrow(/stability .* invalid/i);
    }
  });

  it("rejects an empty voice-id", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const app = { db: testDb.db };
    const page = await createFanslyVoicePage(testDb, "voice-empty-id");

    await expect(setVoiceProfile(app, page.label, { voiceId: "   " })).rejects.toThrow(/voice-id/i);
  });

  it("rejects a non-Fansly page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const app = { db: testDb.db };
    const page = await createOnlyFansVoicePage(testDb, "voice-onlyfans");

    await expect(setVoiceProfile(app, page.label, { voiceId: "voice-1" })).rejects.toThrow(/Fansly/);
    await expect(showVoiceProfile(app, page.label)).rejects.toThrow(/Fansly/);
    await expect(removeVoiceProfile(app, page.label)).rejects.toThrow(/Fansly/);
  });

  it("rejects an unknown page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const app = { db: testDb.db };

    await expect(setVoiceProfile(app, "no-such-page", { voiceId: "voice-1" })).rejects.toThrow(
      /not found/i,
    );
    await expect(showVoiceProfile(app, "no-such-page")).rejects.toThrow(/not found/i);
    await expect(removeVoiceProfile(app, "no-such-page")).rejects.toThrow(/not found/i);
  });
});
