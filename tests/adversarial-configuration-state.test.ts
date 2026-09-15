import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactRouter from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const route = vi.hoisted(() => ({ url: "/settings?tab=configuration", state: null as unknown }));
vi.mock("react-router", async (original) => ({
  ...await original<typeof ReactRouter>(),
  useInRouterContext: () => true,
  useLocation: () => {
    const url = new URL(route.url, "https://hub.invalid");
    return { pathname: url.pathname, search: url.search, hash: url.hash, state: route.state };
  },
  useSearchParams: () => [new URL(route.url, "https://hub.invalid").searchParams, vi.fn()],
  useNavigate: () => vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/adminConfig.ts", () => ({
  useAdminConfig: vi.fn(), useConfigPages: vi.fn(), useUpdateConfig: vi.fn(),
  useClearConfig: vi.fn(), useStagedConfig: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ KernelApiError: class extends Error {} }));
vi.mock("../apps/dashboard/src/pages/settings/CredentialsTab.tsx", () => ({ CredentialsTab: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/SyncTab.tsx", () => ({ SyncTab: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/CollectionTab.tsx", () => ({ CollectionTab: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/ModelsTab.tsx", () => ({ ModelsTab: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/PagesTab.tsx", () => ({ PagesTab: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/AiPersonasTab.tsx", () => ({ AiPersonasTab: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/team/TeamTab.tsx", () => ({ TeamTab: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/team/TechnicalTab.tsx", () => ({ TechnicalTab: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/FeaturesTab.tsx", () => ({ FeaturesTab: () => null }));

import { SettingsPage } from "../apps/dashboard/src/pages/SettingsPage.tsx";
import { ConfigurationTab } from "../apps/dashboard/src/pages/settings/ConfigurationTab.tsx";

type Element = ReactElement<Record<string, unknown>>;
function asElement(node: ReactNode): Element {
  if (!isValidElement(node)) throw new Error("Expected a React element");
  return node as Element;
}

function configurationForm(url: string): Element {
  route.url = url;
  const routed = asElement(ConfigurationTab());
  // The router wrapper has no local state. Inspect its actual element, without
  // substituting a mock form: React uses its type and key for state retention.
  if (typeof routed.type !== "function") throw new Error("Expected the routed configuration component");
  return asElement((routed.type as () => ReactNode)());
}

function descendants(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const element = asElement(child);
    return [element, ...descendants(element.props.children as ReactNode)];
  });
}

beforeEach(() => {
  route.url = "/settings?tab=configuration";
  route.state = null;
});

describe("configuration form lifetime across scope navigation", () => {
  // Editor tests separately cover frozen versions and returned write receipts.
  // Those guarantees require their mounted parent to survive these transitions;
  // an SSR snapshot cannot catch a changed React key.
  it("retains the same form through full → focused → another feature → full", () => {
    const forms = [
      "/settings?tab=configuration",
      "/settings?tab=configuration&feature=voice",
      "/settings?tab=configuration&feature=earnings",
      "/settings?tab=configuration",
    ].map(configurationForm);

    for (const form of forms) {
      expect(form.type).toBe(forms[0]!.type);
      expect(form.key).toBe(forms[0]!.key);
    }
    expect(forms[1]!.props.feature).toMatchObject({ id: "voice" });
    expect(forms[2]!.props.feature).toMatchObject({ id: "earnings" });
    expect(forms[3]!.props.feature).toBeNull();
  });

  it("keeps the form mounted when the active Работа Hub section opens all parameters", () => {
    const focused = configurationForm("/settings?tab=configuration&feature=voice&view=all&q=voice&page=lora-1");
    const activeLink = descendants(SettingsPage()).find((element) => element.props["aria-current"] === "page");
    expect(activeLink?.props.children).toBe("Работа Hub");
    expect(activeLink?.props.to).toBe("/settings?tab=configuration&page=lora-1");
    const full = configurationForm(String(activeLink?.props.to));
    expect(full.type).toBe(focused.type);
    expect(full.key).toBe(focused.key);
  });

  it("opens all settings directly from a focused form with its remaining navigation context", () => {
    const context = { backTo: "/usage?period=30d" };
    route.state = context;
    const focused = configurationForm("/settings?tab=configuration&feature=voice&view=all&q=voice&page=lora-1");
    expect(focused.props.allSettingsHref).toBe("/settings?tab=configuration&page=lora-1");
    expect(focused.props.navigationState).toBe(context);

    const full = configurationForm(String(focused.props.allSettingsHref));
    expect(full.type).toBe(focused.type);
    expect(full.key).toBe(focused.key);
    expect(full.props.feature).toBeNull();
    expect(full.props.navigationState).toBe(context);
  });

  it("keeps the form identity while updating return context and revealing a prerequisite", () => {
    const before = configurationForm("/settings?tab=configuration&feature=of-client&view=all");
    const after = configurationForm("/settings?tab=configuration&feature=of-client&view=attention&q=OnlyFans#config-ofapiCreditLedgerEnabled");
    expect(after.type).toBe(before.type);
    expect(after.key).toBe(before.key);
    expect(after.props.hash).toBe("#config-ofapiCreditLedgerEnabled");
    expect(after.props.featureBackTo).toBe("/settings?tab=features&view=attention&feature=of-client&q=OnlyFans");
  });
});
