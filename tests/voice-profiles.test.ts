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
    // Stability lands verbatim in the settings jsonb.
    expect(afterFirst?.settings).toEqual({ stability: "natural" });

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
