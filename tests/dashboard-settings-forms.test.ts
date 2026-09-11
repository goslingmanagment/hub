import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminAiPersona, AssignedPage, ModelListItem } from "@agency_hub_core/contracts";

// Exercise actual handlers against controlled requests. This harness deliberately
// does not claim DOM focus, React batching or browser unmount coverage.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
const requests = vi.hoisted(() => ({
  createModel: vi.fn(), updateModel: vi.fn(), updatePage: vi.fn(), updatePersona: vi.fn(),
  verifyPage: vi.fn(), useAdminModels: vi.fn(), useAdminPages: vi.fn(),
  useAdminVerifyPage: vi.fn(),
  useAdminUpdateModel: vi.fn(), useAdminUpdatePage: vi.fn(), useAdminUpdateAiPersona: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof ReactModule>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
}));
vi.mock("react-router", () => ({
  Link: "a",
  useSearchParams: () => [navigation.search, vi.fn()],
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({
  useAdminCreateModel: () => ({ mutateAsync: requests.createModel, isPending: false }),
  useAdminUpdateModel: requests.useAdminUpdateModel,
  useAdminUpdatePage: requests.useAdminUpdatePage,
  useAdminUpdateAiPersona: requests.useAdminUpdateAiPersona,
  useAdminModels: requests.useAdminModels,
  useAdminPages: requests.useAdminPages,
  useAdminConnections: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useAdminVerifyPage: requests.useAdminVerifyPage,
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({
  KernelApiError: class KernelApiError extends Error {
    status: number;
    constructor(message: string, _category: string, status: number) { super(message); this.status = status; }
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { CreateModelModal } from "../apps/dashboard/src/pages/settings/CreateModelModal.tsx";
import { EditModelModal } from "../apps/dashboard/src/pages/settings/EditModelModal.tsx";
import { EditPageModal } from "../apps/dashboard/src/pages/settings/EditPageModal.tsx";
import { EditPersonaModal } from "../apps/dashboard/src/pages/settings/AiPersonasTab.tsx";
import { PagesTab } from "../apps/dashboard/src/pages/settings/PagesTab.tsx";
import { KernelApiError } from "../apps/dashboard/src/api/sdk.ts";

type Element = ReactElement<Record<string, unknown>>;
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
function render<T>(component: (props: T) => ReactNode, props: T) {
  hooks.cursor = 0;
  return component(props);
}
function change(element: Element, value: string) {
  (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
function submit(tree: ReactNode) {
  return (find(tree, (element) => element.type === "form").props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() });
}
function close(tree: ReactNode) {
  (find(tree, (element) => typeof element.props.onClose === "function").props.onClose as () => void)();
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const model: ModelListItem = { id: 1, slug: "original-model", name: "Original Model", pageCount: 1 };
const page: AssignedPage = {
  id: 1, label: "original-page", platform: "fansly", modelSlug: model.slug, modelName: model.name,
  username: "synthetic", displayName: null, subscriberCount: { value: 0, available: true },
  followerCount: { value: null, available: false }, lastLightSyncAt: null, lastFollowerSyncAt: null,
};
const persona: AdminAiPersona = {
  key: "custom:original", displayName: "Original", systemBlock: "Original instructions",
  version: 7, status: "active", updatedAt: "2026-09-11T09:00:00Z",
};

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  navigation.search = new URLSearchParams();
  vi.resetAllMocks();
  requests.useAdminUpdateModel.mockReturnValue({ mutateAsync: requests.updateModel, isPending: false });
  requests.useAdminUpdatePage.mockReturnValue({ mutateAsync: requests.updatePage, isPending: false });
  requests.useAdminUpdateAiPersona.mockReturnValue({ mutateAsync: requests.updatePersona, isPending: false });
  requests.useAdminVerifyPage.mockReturnValue({ mutateAsync: requests.verifyPage, isPending: false });
  requests.useAdminModels.mockReturnValue({ data: [model], isLoading: false, isError: false, refetch: vi.fn() });
  requests.useAdminPages.mockReturnValue({ data: [page], isLoading: false, isError: false, refetch: vi.fn() });
});

describe("settings form recovery", () => {
  it("prevents duplicate model creation and close while pending, then preserves the failed draft", async () => {
    const onClose = vi.fn();
    const draw = () => render(CreateModelModal, { onClose });
    change(find(draw(), (element) => element.props.maxLength === 100), "new-model");
    change(find(draw(), (element) => element.props.maxLength === 200), "New Model");
    const request = deferred();
    requests.createModel.mockReturnValue(request.promise);
    const treeBeforeRequest = draw();
    const pending = submit(treeBeforeRequest);
    await submit(treeBeforeRequest);
    close(treeBeforeRequest);
    expect(requests.createModel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(find(draw(), (element) => element.type === "fieldset").props.disabled).toBe(true);
    request.reject(new Error("Model already exists"));
    await pending;
    expect(find(draw(), (element) => element.props.role === "alert").props.children).toBe("Model already exists");
    expect(find(draw(), (element) => element.props.maxLength === 100).props.value).toBe("new-model");
    expect(find(draw(), (element) => element.props.maxLength === 200).props.value).toBe("New Model");
    expect(onClose).not.toHaveBeenCalled();
    requests.createModel.mockResolvedValue({});
    await submit(draw());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps model edits after a rejection and sends a changed slug to the original target", async () => {
    const onClose = vi.fn();
    const draw = () => render(EditModelModal, { model, onClose });
    change(find(draw(), (element) => element.props.maxLength === 100), "renamed-model");
    requests.updateModel.mockRejectedValue(new Error("Rename rejected"));
    await submit(draw());
    expect(requests.useAdminUpdateModel).toHaveBeenLastCalledWith("original-model");
    expect(requests.updateModel).toHaveBeenCalledWith({ slug: "renamed-model" });
    expect(find(draw(), (element) => element.props.maxLength === 100).props.value).toBe("renamed-model");
    expect(find(draw(), (element) => element.props.role === "alert").props.children).toBe("Rename rejected");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("preserves the page label and original model when a supporting catalog disappears", async () => {
    const onClose = vi.fn();
    let models = [model];
    const draw = () => render(EditPageModal, { page, models, onClose });
    change(find(draw(), (element) => element.type === "input"), "renamed-page");
    models = [];
    const select = find(draw(), (element) => element.type === "select");
    expect(select.props.value).toBe("original-model");
    expect(find(select, (element) => element.type === "option").props.value).toBe("original-model");
    requests.updatePage.mockRejectedValue(new Error("Page update rejected"));
    await submit(draw());
    expect(requests.useAdminUpdatePage).toHaveBeenLastCalledWith("original-page");
    expect(requests.updatePage).toHaveBeenCalledWith({ label: "renamed-page" });
    expect(find(draw(), (element) => element.type === "input").props.value).toBe("renamed-page");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps a conflicted persona draft and never retries it against a new revision", async () => {
    const onClose = vi.fn();
    const draw = () => render(EditPersonaModal, { persona, onClose });
    const fields = find(draw(), (element) => typeof element.props.onSystemBlockChange === "function");
    (fields.props.onSystemBlockChange as (value: string) => void)("My unsaved instructions");
    requests.updatePersona.mockRejectedValue(new KernelApiError("Conflict", "conflict", 409, null, null));
    await submit(draw());
    expect(requests.updatePersona).toHaveBeenCalledWith({ displayName: "Original", systemBlock: "My unsaved instructions", expectedVersion: 7 });
    expect(find(draw(), (element) => typeof element.props.onSystemBlockChange === "function").props.systemBlock).toBe("My unsaved instructions");
    expect(String(find(draw(), (element) => element.props.role === "alert").props.children)).toContain("Черновик сохранён");
    await submit(draw());
    expect(requests.updatePersona).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the selected edit snapshot mounted across missing or renamed catalog results", () => {
    const draw = () => render(PagesTab, {});
    const row = find(draw(), (element) => element.props.page === page);
    (row.props.onEdit as () => void)();
    requests.useAdminPages.mockReturnValue({ data: [{ ...page, label: "changed-on-server" }], isLoading: false, isError: false });
    requests.useAdminModels.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("Models unavailable") });
    const modal = find(draw(), (element) => element.type === EditPageModal);
    expect(modal.props.page).toBe(page);
    expect(modal.props.models).toEqual([]);
  });

  it("retains page verification flights when search hides and restores the row", async () => {
    const draw = () => render(PagesTab, {});
    const verifyButton = () => {
      const row = find(draw(), (element) => element.props.page === page);
      const rowTree = (row.type as (props: Record<string, unknown>) => ReactNode)(row.props);
      return find(rowTree, (element) => element.props["aria-label"] === `Проверить доступ к ${page.label}`);
    };
    const request = deferred();
    requests.verifyPage.mockReturnValue(request.promise);
    const pending = (verifyButton().props.onClick as () => Promise<void>)();
    navigation.search = new URLSearchParams("pageQuery=missing");
    expect(() => find(draw(), (element) => element.props.page === page)).toThrow("Control not found");
    navigation.search = new URLSearchParams();
    expect(verifyButton().props.disabled).toBe(true);
    await (verifyButton().props.onClick as () => Promise<void>)();
    expect(requests.verifyPage).toHaveBeenCalledTimes(1);
    request.resolve({ verified: true, username: "synthetic" });
    await pending;
    expect(verifyButton().props.disabled).toBe(false);
  });

  it("does not redispatch a verification restored from the shared mutation cache", async () => {
    requests.useAdminVerifyPage.mockReturnValue({ mutateAsync: requests.verifyPage, isPending: true });
    const row = find(render(PagesTab, {}), (element) => element.props.page === page);
    const rowTree = (row.type as (props: Record<string, unknown>) => ReactNode)(row.props);
    const button = find(rowTree, (element) => element.props["aria-label"] === `Проверить доступ к ${page.label}`);
    expect(button.props.disabled).toBe(true);
    await (button.props.onClick as () => Promise<void>)();
    expect(requests.verifyPage).not.toHaveBeenCalled();
  });
});
