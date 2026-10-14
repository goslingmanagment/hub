import {
  bindOnboardedProfile,
  findOnboardingProfile,
  recordOnboardingIdentity,
  requestOnboardingIdentity,
  setPageBrowserOnboarding,
  type Database,
} from "@agency_hub_core/db";

// A new page's onboarding through its browser (Project Browser PR 16), the
// binding without an engine: an identity check answered as the engine's link
// answers one — the onboarding open, the request asked, its account recorded
// in the generation that holds — then the profile bound on that proof, as
// the API's creation binds it (`bindOnboardedProfile` takes nothing else).

export interface OnboardingProof {
  requestId: string;
  onboardingGeneration: bigint;
}

/** The onboarding opened (from off or login) and an identity check of it
 *  answered with `accountId`, as the engine's link records one. */
export async function proveOnboardingAccount(db: Database, profileId: string, accountId = "300000000000000777"): Promise<OnboardingProof> {
  const before = await findOnboardingProfile(db, profileId);
  if (before === null) throw new Error(`no profile ${profileId}`);
  if (before.onboarding !== "open") {
    const moved = await db.transaction((tx) => setPageBrowserOnboarding(tx as unknown as Database, { profileId, to: "open", by: "owner:test" }));
    if (moved.kind !== "changed") throw new Error(`the onboarding of ${profileId} did not open: ${JSON.stringify(moved)}`);
  }
  const requested = await requestOnboardingIdentity(db, { profileId, source: "onboarding" });
  if (requested.kind !== "requested") throw new Error(`no identity request: ${requested.why}`);
  const profile = (await findOnboardingProfile(db, profileId))!;
  const written = await db.transaction((tx) => recordOnboardingIdentity(tx as unknown as Database, {
    profileId,
    result: {
      requestId: requested.requestId,
      ok: true,
      accountId,
      username: null,
      displayName: null,
      sentAt: new Date().toISOString(),
      onboardingGeneration: profile.onboardingGeneration.toString(),
      sessionFingerprint: "test-session",
      observationId: 0,
      attemptId: 1,
    },
  }));
  if (!written) throw new Error("the identity was not recorded");
  return { requestId: requested.requestId, onboardingGeneration: profile.onboardingGeneration };
}

/** The profile proven and bound to `pageId` in one call. */
export async function bindProvenProfile(db: Database, input: { profileId: string; pageId: number }): Promise<boolean> {
  const proof = await proveOnboardingAccount(db, input.profileId);
  return db.transaction((tx) => bindOnboardedProfile(tx as unknown as Database, { ...input, ...proof }));
}
