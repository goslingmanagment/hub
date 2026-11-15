import "@agency_hub_core/ui/styles/console.css";
import "@agency_hub_core/ui/styles/console-pages.css";
import "./fans.css";
import { BySpendListPage } from "./BySpendListPage.js";
import { BySpendPage } from "./BySpendPage.js";
import { FanAnyPageScreen } from "./FanAnyPage.js";
import { FanCardPage } from "./FanCardPage.js";
import { FollowersPage } from "./FollowersPage.js";
import { FansFrame, OnePageGate } from "./frame.js";
import { GonePage } from "./GonePage.js";
import { PayersPage } from "./PayersPage.js";
import { SubscribersPage } from "./SubscribersPage.js";

/**
 * «Фаны» (products package M): the console's screens, moved here as they were — their code, their components (shared
 * ones in packages/ui/src/console), their styles. Everyone's: Hub answers each read by the viewer's teams.
 */
export function FansScreen() {
  return <FansFrame><PayersPage /></FansFrame>;
}
export function FansSubscribersScreen() {
  return <FansFrame><OnePageGate><SubscribersPage /></OnePageGate></FansFrame>;
}
export function FansFollowersScreen() {
  return <FansFrame><OnePageGate><FollowersPage /></OnePageGate></FansFrame>;
}
export function FansGoneScreen() {
  return <FansFrame><OnePageGate><GonePage /></OnePageGate></FansFrame>;
}
export function FansBySpendScreen() {
  return <FansFrame><OnePageGate><BySpendPage /></OnePageGate></FansFrame>;
}
export function FansBySpendListScreen() {
  return <FansFrame><OnePageGate><BySpendListPage /></OnePageGate></FansFrame>;
}
export function FanScreen() {
  return <FansFrame><FanCardPage /></FansFrame>;
}
export function FanAnyPage() {
  return <FansFrame><FanAnyPageScreen /></FansFrame>;
}
