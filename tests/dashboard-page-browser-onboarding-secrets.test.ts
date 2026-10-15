import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PageBrowserLoginStepResponse } from "@agency_hub_core/contracts";

// A new page's onboarding on the dashboard's side (Project Browser PR 16):
// PR 15's proof for the login form, on the onboarding's path and for the
// proxy's password too — they go straight to the API, never through React
// Query (a mutation keeps its arguments in the client's cache for its gcTime
// after the page is gone), so nothing of what was typed stays in the query
// client. The real QueryClient, the API client mocked.

const sdk = vi.hoisted(() => ({
  pageBrowserProfileProxy: vi.fn(),
  pageBrowserProfileLoginSubmit: vi.fn(),
  pageBrowserProfileLoginCode: vi.fn(),
  pageBrowserProxyCheck: vi.fn(),
  pageBrowserDraftSave: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));

import { QueryClient } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import {
  pageBrowserProfileKey,
  sendPageBrowserProfileLoginStep,
  sendPageBrowserProfileProxy,
} from "../apps/dashboard/src/api/pageBrowserOnboarding.ts";
import { checkPageBrowserProxy, pageBrowserDraftsKey, savePageBrowserDraft } from "../apps/dashboard/src/api/pageBrowserDrafts.ts";

const PROFILE = "0b5c1f7e-6c2a-4f0e-9d61-2a1f3c4d5e6f";
const LOGIN = "pb16-dash-login-8c1d2e";
const PASSWORD = "pb16-dash-password-3f6a9b10";
const CODE = "481957";
const PROXY_PASSWORD = "pb16-dash-proxy-password-7e2c";
const MARKERS = [LOGIN, PASSWORD, CODE, PROXY_PASSWORD];

const MASKED = { scheme: "socks5", host: "203.0.113.50", port: 1080, username: "pb-user", passwordSet: true };
const CHECK = "4b1f0e2a-9c3d-4e5f-8a7b-6c5d4e3f2a1b";
const ENV = { timeZone: "Europe/Berlin", languages: ["de-DE", "de", "en-US", "en"], geolocation: { latitude: 52.52, longitude: 13.4, accuracyM: 1000 } };

const ANSWER: PageBrowserLoginStepResponse = { screen: { screen: "code", screenVersion: "fansly-login/1", fields: ["code"], siteError: null }, refused: null, unreachable: false };

function held(qc: QueryClient): string {
  const mutations = qc.getMutationCache().getAll().map((mutation) => ({ state: mutation.state, key: mutation.options.mutationKey ?? null }));
  const queries = qc.getQueryCache().getAll().map((query) => ({ key: query.queryKey, state: query.state }));
  return JSON.stringify({ mutations, queries });
}

beforeEach(() => {
  sdk.pageBrowserProfileProxy.mockReset().mockResolvedValue({ proxy: MASKED });
  sdk.pageBrowserProxyCheck.mockReset().mockResolvedValue({ ok: true, proxy: MASKED });
  sdk.pageBrowserDraftSave.mockReset().mockResolvedValue({ name: "ari-2", proxy: MASKED });
  sdk.pageBrowserProfileLoginSubmit.mockReset().mockResolvedValue(ANSWER);
  sdk.pageBrowserProfileLoginCode.mockReset().mockResolvedValue({ ...ANSWER, screen: { ...ANSWER.screen!, screen: "success", fields: [] } });
});

describe("a new page's onboarding and the query client (PR 16)", () => {
  it("the proxy and the form's steps go straight to the API: nothing of what was typed in the client — answered or failed", async () => {
    const qc = new QueryClient();
    qc.setQueryData(pageBrowserProfileKey(PROFILE), { login: { state: "login" } });
    const proxy = { text: `203.0.113.50:1080:pb-user:${PROXY_PASSWORD}` };
    expect(await sendPageBrowserProfileProxy(qc, PROFILE, proxy, CHECK)).toEqual({ proxy: MASKED });
    expect(sdk.pageBrowserProfileProxy).toHaveBeenCalledWith({ params: { profileId: PROFILE }, body: { proxy, checkId: CHECK } });
    expect(await sendPageBrowserProfileLoginStep(qc, PROFILE, { kind: "submit", login: LOGIN, password: PASSWORD })).toEqual(ANSWER);
    expect(sdk.pageBrowserProfileLoginSubmit).toHaveBeenCalledWith({ params: { profileId: PROFILE }, body: { login: LOGIN, password: PASSWORD } });
    expect(await sendPageBrowserProfileLoginStep(qc, PROFILE, { kind: "code", code: CODE })).toMatchObject({ screen: { screen: "success" } });
    // Failed: no retry, nothing kept.
    sdk.pageBrowserProfileProxy.mockRejectedValueOnce(new Error("the API cannot be reached"));
    await expect(sendPageBrowserProfileProxy(qc, PROFILE, proxy, CHECK)).rejects.toThrow("cannot be reached");
    expect(sdk.pageBrowserProfileProxy).toHaveBeenCalledTimes(2);

    expect(qc.getMutationCache().getAll()).toHaveLength(0);
    const text = held(qc);
    for (const marker of MARKERS) expect(text, marker).not.toContain(marker);
    // The onboarding is read anew after each.
    expect(qc.getQueryCache().find({ queryKey: pageBrowserProfileKey(PROFILE) })?.state.isInvalidated).toBe(true);
  });

  it("a pasted proxy's check and the draft's save (owner decision 2026-10-15) go straight to the API: nothing of the proxy's password in the client", async () => {
    const qc = new QueryClient();
    qc.setQueryData(pageBrowserDraftsKey, { drafts: [], pages: [] });
    const proxy = { text: `socks5://pb-user:${PROXY_PASSWORD}@203.0.113.50:1080` };
    expect(await checkPageBrowserProxy({ kind: "text", proxy })).toMatchObject({ ok: true });
    expect(sdk.pageBrowserProxyCheck).toHaveBeenCalledWith({ body: { source: { kind: "text", proxy } } });
    const body = { existingPage: false, proxy, env: ENV, checkId: CHECK, expectedRevision: null };
    expect(await savePageBrowserDraft(qc, "ari-2", body)).toMatchObject({ name: "ari-2" });
    expect(sdk.pageBrowserDraftSave).toHaveBeenCalledWith({ params: { name: "ari-2" }, body });
    sdk.pageBrowserDraftSave.mockRejectedValueOnce(new Error("the API cannot be reached"));
    await expect(savePageBrowserDraft(qc, "ari-2", body)).rejects.toThrow("cannot be reached");
    expect(qc.getMutationCache().getAll()).toHaveLength(0);
    expect(held(qc)).not.toContain(PROXY_PASSWORD);
    // The drafts are read anew after a save.
    expect(qc.getQueryCache().find({ queryKey: pageBrowserDraftsKey })?.state.isInvalidated).toBe(true);
  });
});
