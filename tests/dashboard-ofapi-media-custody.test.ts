import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type * as ReactQuery from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { QueryClient } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelApiError, ofapiMediaRouteSchemas } from "@agency_hub_core/contracts";

// Real page handlers and query-cache workspace; remount drops React state and
// reload drops the query cache. The synthetic tab retains only sessionStorage.
const state = vi.hoisted(() => ({
  client: null as unknown, values: [] as unknown[], cursor: 0,
  search: new URLSearchParams("page=original-page"), ownerId: 1, role: "owner",
  upload: vi.fn(), collect: vi.fn(), refetch: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof ReactModule>(),
  useState(initial: unknown) {
    const values = state.values, index = state.cursor++;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (next: unknown) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
  },
  useRef(initial: unknown) {
    const index = state.cursor++;
    if (!(index in state.values)) state.values[index] = { current: initial };
    return state.values[index];
  },
  useEffect: () => undefined,
}));
vi.mock("../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js", async original => {
  const actual = await original<typeof ReactQuery>();
  return { ...actual, useQueryClient: () => state.client,
    useQuery: ({ queryKey, initialData }: { queryKey: string[]; initialData: () => unknown }) => {
      const client = state.client as QueryClient;
      if (!client.getQueryState(queryKey)) client.setQueryData(queryKey, initialData());
      return { data: client.getQueryData(queryKey) };
    },
  };
});
vi.mock("react-router", () => ({
  Link: "a",
  useSearchParams: () => [state.search, (value: URLSearchParams) => { state.search = value; }],
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({
  useAuthMe: () => ({ data: { user: { id: state.ownerId, role: state.role } } }),
}));
vi.mock("../apps/dashboard/src/api/ofapiExports.ts", () => ({
  useOfapiExportPages: () => ({ data: { pages: [{ id: 7, label: "original-page" }, { id: 8, label: "other-page" }], revision: 3, backgroundPaused: false }, refetch: state.refetch }),
}));
vi.mock("../apps/dashboard/src/api/ofapiMedia.ts", () => ({
  ofapiMediaActions: { upload: state.upload, collect: state.collect },
  useOfapiMedia: () => ({ data: { sources: [{ id: "00000000-0000-4000-8000-000000000001", filename: "owned.jpg", bytes: 1000, sha256: "a".repeat(64), mimeType: "image/jpeg" }], uploads: [], media: [], totalMedia: 0, inventory: { state: "unknown", note: "Unknown coverage" } }, refetch: state.refetch }),
}));

import { OfapiMediaPage } from "../apps/dashboard/src/pages/OfapiMediaPage.tsx";
import {
  acknowledgeSeparateMediaUpload, mediaUploadCustodyKey, mediaUploadFailure,
  parseMediaUploadCustody, readMediaUploadCustody, settleMediaUpload, startMediaUpload,
  type MediaUploadBody, type MediaUploadRecord,
} from "../apps/dashboard/src/lib/ofapiMediaCustody.ts";
import { collectionJobStorageKey, restoreCollectionJobLaunch, serializeCollectionJobLaunch } from "../apps/dashboard/src/pages/settings/collection/collectionJobCustody.ts";

type Element = ReactElement<Record<string, unknown>>;
const sourceId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const nextRequestId = "00000000-0000-4000-8000-000000000003";
const body: MediaUploadBody = { pageId: 7, sourceId, destination: "vault", requestId, expectedPolicyRevision: 3, maxCredits: 7, dryRun: false };
const record: MediaUploadRecord = { body, pageLabel: "original-page", sourceFilename: "owned.jpg", startedAt: "2026-09-11T10:00:00Z", phase: "sending", receipt: null, error: "" };
const receipt = (input = body) => ofapiMediaRouteSchemas.ofapiMediaUploadCreate.response[200].parse({
  dryRun: input.dryRun, jobId: input.dryRun ? null : "confirmed-upload-job", sourceId: input.sourceId,
  sha256: "a".repeat(64), bytes: 1000, destination: input.destination, estimatedCredits: 1,
  maxCredits: input.maxCredits, state: input.dryRun ? "preview" : "ready",
});
let saved: Map<string, string>;
let failWrite: boolean;
let clients: QueryClient[];
function newClient() { const client = new QueryClient(); clients.push(client); state.client = client; }
function draw() {
  state.cursor = 0;
  const page = OfapiMediaPage() as Element;
  return (page.type as (props: Record<string, unknown>) => ReactNode)(page.props);
}
function remount(page = "original-page", reload = false) {
  state.values = [];
  state.search = new URLSearchParams({ page });
  if (reload) newClient();
  return draw();
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function find(node: ReactNode, matches: (element: Element) => boolean): Element {
  const queue: ReactNode[] = [node];
  while (queue.length) {
    const child = queue.shift();
    if (Array.isArray(child)) { queue.push(...child); continue; }
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (matches(child)) return child;
    queue.push(child.props.children as ReactNode);
  }
  throw new Error("Control not found");
}
function button(node: ReactNode, label: string) { return find(node, element => element.type === "button" && textOf(element) === label); }
function click(element: Element) { (element.props.onClick as () => void)(); }
function change(element: Element, value: string) { (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function workspace<T>(name: string) { return (state.client as QueryClient).getQueryData<T>(["dashboard-workspace", `ofapi-media:${state.ownerId}:${name}`]); }
async function prepare() {
  change(find(draw(), element => element.type === "select" && textOf(element).includes("Выберите исходник")), sourceId);
  change(find(draw(), element => element.type === "input" && element.props.type === "number"), "7");
  click(button(draw(), "2. Проверить загрузку"));
  await vi.waitFor(() => expect(workspace("busy")).toBe(false));
  return button(draw(), "3. Подтвердить одну загрузку");
}

beforeEach(() => {
  saved = new Map(); failWrite = false; clients = [];
  state.values = []; state.cursor = 0; state.ownerId = 1; state.role = "owner";
  state.search = new URLSearchParams("page=original-page");
  vi.resetAllMocks(); newClient();
  state.refetch.mockResolvedValue({});
  state.upload.mockImplementation((input: MediaUploadBody) => Promise.resolve(receipt(input)));
  const events = new EventTarget();
  vi.stubGlobal("window", { sessionStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failWrite) throw new Error("Storage unavailable"); saved.set(key, value); },
    removeItem: (key: string) => saved.delete(key),
  }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
});
afterEach(() => { clients.forEach(client => client.clear()); vi.unstubAllGlobals(); });

describe("Media request custody", () => {
  it("retains the exact approval across reload and refuses a new ID or changed replay body", () => {
    startMediaUpload(1, record);
    expect(readMediaUploadCustody(1).current).toMatchObject({ body, phase: "uncertain", pageLabel: "original-page" });
    expect(readMediaUploadCustody(2).current).toBeNull();
    expect(() => parseMediaUploadCustody(saved.get(mediaUploadCustodyKey(1))!, 2)).toThrow();
    expect(() => startMediaUpload(1, { ...record, body: { ...body, requestId: nextRequestId } })).toThrow();
    expect(() => startMediaUpload(1, { ...record, body: { ...body, maxCredits: 8 } })).toThrow();
    expect(startMediaUpload(1, { ...readMediaUploadCustody(1).current!, phase: "sending" }).current?.body).toEqual(body);
  });

  it("requires acknowledgement for a separate upload and settles a late original receipt into history", () => {
    startMediaUpload(1, record);
    expect(() => acknowledgeSeparateMediaUpload(1, requestId, false)).toThrow();
    acknowledgeSeparateMediaUpload(1, requestId, true);
    startMediaUpload(1, { ...record, body: { ...body, pageId: 8, requestId: nextRequestId }, pageLabel: "other-page" });
    const outcome = settleMediaUpload(1, { ...record, phase: "confirmed", receipt: receipt() });
    expect(outcome.current).toMatchObject({ pageLabel: "other-page", body: { requestId: nextRequestId } });
    expect(outcome.history).toMatchObject([{ phase: "confirmed", receipt: { jobId: "confirmed-upload-job" }, body }]);
    expect(settleMediaUpload(1, { ...record, phase: "uncertain", error: "Late original response lost" }).history).toEqual(outcome.history);
    expect(startMediaUpload(1, record)).toEqual(outcome);
  });

  it("never turns a later policy refusal into proof that an unknown upload did not start", () => {
    const conflict = new KernelApiError("Policy changed", "conflict", 409, "conflict", null);
    expect(mediaUploadFailure(conflict, false).phase).toBe("refused");
    expect(mediaUploadFailure(conflict, true).phase).toBe("uncertain");
    expect(mediaUploadFailure(new Error("Response lost"), false).phase).toBe("uncertain");
    expect(() => settleMediaUpload(1, { ...record, phase: "confirmed", receipt: { ...receipt(), sourceId: nextRequestId } })).toThrow();
  });
});

describe("Media page action lifetime", () => {
  it("admits one synchronous confirmation, keeps its pending state on another account and receives a late result after route remount", async () => {
    const confirm = await prepare();
    const request = deferred<ReturnType<typeof receipt>>();
    state.upload.mockImplementation((input: MediaUploadBody) => {
      expect(readMediaUploadCustody(1, false).current?.body).toEqual(input);
      return request.promise;
    });
    click(confirm); click(confirm);
    expect(state.upload).toHaveBeenCalledTimes(2); // one preview and one approved request
    const approved = state.upload.mock.calls[1]![0] as MediaUploadBody;
    expect(approved).toMatchObject({ pageId: 7, maxCredits: 7, dryRun: false });
    const other = remount("other-page");
    expect(textOf(other)).toContain("original-page: обрабатываем подтверждённое действие");
    expect(button(other, "Проверить параметры сбора каталога").props.disabled).toBe(true);
    click(confirm);
    expect(state.upload).toHaveBeenCalledTimes(2);
    request.resolve(receipt(approved));
    await vi.waitFor(() => expect(workspace("busy")).toBe(false));
    expect(textOf(draw())).toContain("confirmed-upload-job");
    expect(readMediaUploadCustody(1).current).toMatchObject({ phase: "confirmed", body: approved });
    expect(workspace<Record<number, string>>("sources")?.[7]).toBe(sourceId);
  });

  it.each(["success", "network failure", "refusal"] as const)("restores the exact approval after reload without automatic POST and preserves its receipt after the original %s", async lateOutcome => {
    const confirm = await prepare();
    const interrupted = deferred<ReturnType<typeof receipt>>();
    const originalClient = state.client as QueryClient;
    state.upload.mockReturnValueOnce(interrupted.promise);
    click(confirm);
    const approved = state.upload.mock.calls[1]![0] as MediaUploadBody;
    let tree = remount("other-page", true);
    expect(state.upload).toHaveBeenCalledTimes(2);
    expect(button(tree, "2. Проверить загрузку").props.disabled).toBe(true);
    state.upload.mockResolvedValueOnce(receipt(approved));
    click(button(tree, "Восстановить исходную загрузку с тем же ID"));
    await vi.waitFor(() => expect(workspace("busy")).toBe(false));
    expect(state.upload).toHaveBeenLastCalledWith(approved);
    expect(state.upload).toHaveBeenCalledTimes(3);
    tree = draw();
    expect(textOf(tree)).toContain("original-page");
    expect(textOf(tree)).toContain("confirmed-upload-job");
    if (lateOutcome === "success") interrupted.resolve(receipt(approved));
    else interrupted.reject(lateOutcome === "refusal"
      ? new KernelApiError("Policy changed", "conflict", 409, "conflict", null)
      : new Error("Original response lost"));
    await vi.waitFor(() => expect(originalClient.getQueryData(["dashboard-workspace", "ofapi-media:1:busy"])).toBe(false));
    expect(readMediaUploadCustody(1).current).toMatchObject({ phase: "confirmed", body: approved, receipt: { jobId: "confirmed-upload-job" } });
    expect(originalClient.getQueryData(["dashboard-workspace", "ofapi-media:1:upload-custody"])).toMatchObject({ current: { phase: "confirmed", receipt: { jobId: "confirmed-upload-job" } } });
    expect(originalClient.getQueryData(["dashboard-workspace", "ofapi-media:1:error"])).toBe("");
  });

  it("consumes an already confirmed saved receipt from a stale recovery view without another POST", async () => {
    startMediaUpload(1, record);
    const staleRecovery = button(draw(), "Восстановить исходную загрузку с тем же ID");
    settleMediaUpload(1, { ...record, phase: "confirmed", receipt: receipt() });
    click(staleRecovery);
    await vi.waitFor(() => expect(workspace("busy")).toBe(false));
    expect(state.upload).not.toHaveBeenCalled();
    expect(readMediaUploadCustody(1).current).toMatchObject({ phase: "confirmed", receipt: { jobId: "confirmed-upload-job" } });
    expect(textOf(draw())).toContain("confirmed-upload-job");
  });

  it("fails closed before an approved POST if storage cannot retain it, and leaves recovery read-only for team leads", async () => {
    const confirm = await prepare(); failWrite = true;
    click(confirm);
    await vi.waitFor(() => expect(workspace("busy")).toBe(false));
    expect(state.upload).toHaveBeenCalledTimes(1);
    expect(textOf(draw())).toContain("Отправка не началась");
    failWrite = false; startMediaUpload(1, record); state.role = "team_lead";
    const tree = remount("original-page", true);
    expect(textOf(tree)).toContain("owned.jpg");
    expect(textOf(tree)).not.toContain("Восстановить исходную загрузку с тем же ID");
    expect(textOf(tree)).not.toContain("Разрешить отдельную новую загрузку");
  });

  it("routes metadata jobs through the shared Collection custody and prevents the Collection-to-Media bypass after reload", async () => {
    click(button(draw(), "Проверить параметры сбора каталога"));
    const confirm = button(draw(), "Подтвердить сбор метаданных");
    const request = deferred<{ id: string; state: "queued" }>(); state.collect.mockReturnValue(request.promise);
    click(confirm); click(confirm);
    expect(state.collect).toHaveBeenCalledTimes(1);
    const approved = state.collect.mock.calls[0]![0];
    expect(restoreCollectionJobLaunch(saved.get(collectionJobStorageKey(1))!, 1)).toMatchObject({ pageLabel: "original-page", body: approved, phase: "uncertain" });
    request.reject(new Error("Response lost"));
    await vi.waitFor(() => expect(workspace("busy")).toBe(false));
    const tree = remount("other-page", true);
    expect(button(tree, "Проверить параметры сбора каталога").props.disabled).toBe(true);
    expect(textOf(tree)).toContain("original-page");
    expect(state.collect).toHaveBeenCalledTimes(1);
  });

  it("blocks metadata confirmation when another Collection view launched a job after this preview", async () => {
    click(button(draw(), "Проверить параметры сбора каталога"));
    const confirm = button(draw(), "Подтвердить сбор метаданных");
    saved.set(collectionJobStorageKey(1), serializeCollectionJobLaunch({
      ownerId: 1, launchId: "existing-collection-launch", pageLabel: "other-page", startedAt: "2026-09-11T10:00:00Z",
      phase: "sending", jobId: null, error: "", body: { pageId: 8, category: "visitors", expectedRevision: 3, maxCredits: 7, maxCalls: 5, maxBytes: 1000, from: null, to: null, selection: [] },
    }));
    click(confirm);
    await vi.waitFor(() => expect(workspace("busy")).toBe(false));
    expect(state.collect).not.toHaveBeenCalled();
  });
});
