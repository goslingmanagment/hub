/**
 * Group settings: Настройки (design/screens/settings.md). The routes and what they
 * render until each screen is rebuilt. Every screen here is the owner's. Connecting
 * a page lies in these addresses and is the fans-page group's.
 */
import { lazy } from "react";
import { Route, useParams, useSearchParams } from "react-router";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import { PageHeader } from "@/components/ui/PageHeader";
import { DayNav } from "@/components/ui/PeriodStepper";
import { decodeRouteSegment } from "@/lib/navigation";
import { named, Owner } from "./shared.js";

const PagesTab = named(() => import("@/pages/settings/PagesTab"), "PagesTab");
const AiPersonasTab = named(() => import("@/pages/settings/AiPersonasTab"), "AiPersonasTab");
const FeaturesTab = named(() => import("@/pages/settings/FeaturesTab"), "FeaturesTab");
const ConfigurationTab = named(() => import("@/pages/settings/ConfigurationTab"), "ConfigurationTab");
const AiChatterLimitsSection = lazy(() => import("@/pages/AiChatterLimitsSection").then((module) => ({ default: module.AiChatterLimitsSection })));
const NotificationsSettingsSection = named(() => import("@/pages/settings/NotificationsSettingsSection"), "NotificationsSettingsSection");

/** A day's personal AI limits: the day is the screen's own, in the address. */
function AiLimitsScreen() {
  const [search, setSearch] = useSearchParams();
  const today = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
  const asked = search.get("day");
  const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? asked : today;
  const go = (next: string) => {
    const query = new URLSearchParams(search);
    if (next === today) query.delete("day");
    else query.set("day", next);
    setSearch(query);
  };
  return (
    <>
      <PageHeader actions={<DayNav day={day} today={today} onChange={go} />} />
      <AiChatterLimitsSection day={day} />
    </>
  );
}

function PersonaScreen() {
  const { key = "" } = useParams<{ key: string }>();
  return (
    <>
      <PageHeader title={decodeRouteSegment(key)} />
      <AiPersonasTab />
    </>
  );
}

/** A new persona, until the long form has its page: the list that opens the form. */
function NewPersonaScreen() {
  return (
    <>
      <PageHeader title="Новая персона" />
      <AiPersonasTab />
    </>
  );
}

export function settingsRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="settings/pages" element={<PagesTab />} />
      <Route path="settings/ai/personas" element={<AiPersonasTab />} />
      <Route path="settings/ai/personas/:key" element={<PersonaScreen />} />
      <Route path="settings/ai/new-persona" element={<NewPersonaScreen />} />
      <Route path="settings/ai/features" element={<FeaturesTab />} />
      <Route path="settings/ai/features/:featureId" element={<ConfigurationTab />} />
      <Route path="settings/ai/limits" element={<AiLimitsScreen />} />
      <Route path="settings/notifications" element={<NotificationsSettingsSection />} />
    </Route>
  );
}
