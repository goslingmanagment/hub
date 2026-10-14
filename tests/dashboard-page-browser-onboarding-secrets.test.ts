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
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));

import { QueryClient } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import {
  pageBrowserProfileKey,
  sendPageBrowserProfileLoginStep,
  sendPageBrowserProfileProxy,
} from "../apps/dashboard/src/api/pageBrowserOnboarding.ts";

const PROFILE = "0b5c1f7e-6c2a-4f0e-9d61-2a1f3c4d5e6f";
const LOGIN = "pb16-dash-login-8c1d2e";
const PASSWORD = "pb16-dash-password-3f6a9b10";
const CODE = "481957";
const PROXY_PASSWORD = "pb16-dash-proxy-password-7e2c";
const MARKERS = [LOGIN, PASSWORD, CODE, PROXY_PASSWORD];

const ANSWER: PageBrowserLoginStepResponse = { screen: { screen: "code", screenVersion: "fansly-login/1", fields: ["code"], siteError: null }, refused: null, unreachable: false };

function held(qc: QueryClient): string {
  const mutations = qc.getMutationCache().getAll().map((mutation) => ({ state: mutation.state, key: mutation.options.mutationKey ?? null }));
  const queries = qc.getQueryCache().getAll().map((query) => ({ key: query.queryKey, state: query.state }));
  return JSON.stringify({ mutations, queries });
}

beforeEach(() => {
  sdk.pageBrowserProfileProxy.mockReset().mockResolvedValue({ exitIp: "203.0.113.7" });
  sdk.pageBrowserProfileLoginSubmit.mockReset().mockResolvedValue(ANSWER);
  sdk.pageBrowserProfileLoginCode.mockReset().mockResolvedValue({ ...ANSWER, screen: { ...ANSWER.screen!, screen: "success", fields: [] } });
});

describe("a new page's onboarding and the query client (PR 16)", () => {
  it("the proxy and the form's steps go straight to the API: nothing of what was typed in the client — answered or failed", async () => {
    const qc = new QueryClient();
    qc.setQueryData(pageBrowserProfileKey(PROFILE), { login: { state: "login" } });
    const proxy = { url: "socks5://203.0.113.50:1080", username: "pb-user", password: PROXY_PASSWORD };
    expect(await sendPageBrowserProfileProxy(qc, PROFILE, proxy)).toEqual({ exitIp: "203.0.113.7" });
    expect(sdk.pageBrowserProfileProxy).toHaveBeenCalledWith({ params: { profileId: PROFILE }, body: { proxy } });
    expect(await sendPageBrowserProfileLoginStep(qc, PROFILE, { kind: "submit", login: LOGIN, password: PASSWORD })).toEqual(ANSWER);
    expect(sdk.pageBrowserProfileLoginSubmit).toHaveBeenCalledWith({ params: { profileId: PROFILE }, body: { login: LOGIN, password: PASSWORD } });
    expect(await sendPageBrowserProfileLoginStep(qc, PROFILE, { kind: "code", code: CODE })).toMatchObject({ screen: { screen: "success" } });
    // Failed: no retry, nothing kept.
    sdk.pageBrowserProfileProxy.mockRejectedValueOnce(new Error("the API cannot be reached"));
    await expect(sendPageBrowserProfileProxy(qc, PROFILE, proxy)).rejects.toThrow("cannot be reached");
    expect(sdk.pageBrowserProfileProxy).toHaveBeenCalledTimes(2);

    expect(qc.getMutationCache().getAll()).toHaveLength(0);
    const text = held(qc);
    for (const marker of MARKERS) expect(text, marker).not.toContain(marker);
    // The onboarding is read anew after each.
    expect(qc.getQueryCache().find({ queryKey: pageBrowserProfileKey(PROFILE) })?.state.isInvalidated).toBe(true);
  });
});
