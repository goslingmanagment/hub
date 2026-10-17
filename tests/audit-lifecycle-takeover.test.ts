import { expect, it } from "vitest";
import { Pacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import { FakeClock, FakeOwnership, FakePauseSource, ScriptedRng } from "./helpers/sync-fakes.ts";

it("audit I5: first takeover send respects S raised during its initial wait", async () => {
  const clock = new FakeClock();
  const pause = new FakePauseSource(2_000);
  const pacer = new Pacer({ clock, pause, ownership: new FakeOwnership(), rng: new ScriptedRng([0]) });
  const takeoverAt = clock.monoNow();
  pacer.initTakeover(2_400);
  clock.onSleep = () => { pause.settingMs = 60_000; };
  const grant = await pacer.waitForSlot(new AbortController().signal);
  const admission = pacer.arm(grant, 1, clock.monoNow());
  expect(pacer.check(admission)).toBeNull();
  expect(grant.settingMs).toBe(60_000);
  expect(admission.sentMono! - takeoverAt).toBeGreaterThanOrEqual(1.2 * grant.settingMs);
});
