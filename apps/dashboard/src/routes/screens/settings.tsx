/**
 * Group settings: Настройки (design/screens/settings.md). Every screen here is the
 * owner's: hidden in the menu and refused by the route. Connecting a page lies in
 * these addresses and is the fans-page group's.
 */
import { Route } from "react-router";
import { named, Owner } from "./shared.js";

const ModelsPagesPage = named(() => import("@/pages/settings/pages/ModelsPagesPage"), "ModelsPagesPage");
const PersonasPage = named(() => import("@/pages/settings/ai/PersonasPage"), "PersonasPage");
const PersonaPage = named(() => import("@/pages/settings/ai/PersonaPage"), "PersonaPage");
const NewPersonaPage = named(() => import("@/pages/settings/ai/NewPersonaPage"), "NewPersonaPage");
const AiFeaturesPage = named(() => import("@/pages/settings/ai/AiFeaturesPage"), "AiFeaturesPage");
const FeatureParamsPage = named(() => import("@/pages/settings/ai/FeatureParamsPage"), "FeatureParamsPage");
const AiLimitsPage = named(() => import("@/pages/settings/ai/AiLimitsPage"), "AiLimitsPage");
const NotificationsPage = named(() => import("@/pages/settings/notifications/NotificationsPage"), "NotificationsPage");

export function settingsRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="settings/pages" element={<ModelsPagesPage />} />
      <Route path="settings/ai/personas" element={<PersonasPage />} />
      <Route path="settings/ai/personas/:key" element={<PersonaPage />} />
      <Route path="settings/ai/new-persona" element={<NewPersonaPage />} />
      <Route path="settings/ai/features" element={<AiFeaturesPage />} />
      <Route path="settings/ai/features/:featureId" element={<FeatureParamsPage />} />
      <Route path="settings/ai/limits" element={<AiLimitsPage />} />
      <Route path="settings/notifications" element={<NotificationsPage />} />
    </Route>
  );
}
