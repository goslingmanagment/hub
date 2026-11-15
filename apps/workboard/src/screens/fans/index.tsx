import "@agency_hub_core/ui/styles/console.css";
import "@agency_hub_core/ui/styles/console-pages.css";
import "./fans.css";
import { BySpendListPage } from "./BySpendListPage.js";
import { BySpendPage } from "./BySpendPage.js";
import { FanAnyPageScreen } from "./FanAnyPage.js";
import { FanCardPage } from "./FanCardPage.js";
import { FollowersPage } from "./FollowersPage.js";
import { OnePageGate } from "./frame.js";
import { GonePage } from "./GonePage.js";
import { PayersPage } from "./PayersPage.js";
import { SubscribersPage } from "./SubscribersPage.js";

/**
 * «Фаны» (products package M): the console's screens, moved here as they were — their code, their components (shared
 * ones in packages/ui/src/console), their styles. Everyone's: Hub answers each read by the viewer's teams.
 */
export function FansScreen() {
  return <div className="console-kit"><PayersPage /></div>;
}
export function FansSubscribersScreen() {
  return <div className="console-kit"><OnePageGate><SubscribersPage /></OnePageGate></div>;
}
export function FansFollowersScreen() {
  return <div className="console-kit"><OnePageGate><FollowersPage /></OnePageGate></div>;
}
export function FansGoneScreen() {
  return <div className="console-kit"><OnePageGate><GonePage /></OnePageGate></div>;
}
export function FansBySpendScreen() {
  return <div className="console-kit"><OnePageGate><BySpendPage /></OnePageGate></div>;
}
export function FansBySpendListScreen() {
  return <div className="console-kit"><OnePageGate><BySpendListPage /></OnePageGate></div>;
}
export function FanScreen() {
  return <div className="console-kit"><FanCardPage /></div>;
}
export function FanAnyPage() {
  return <div className="console-kit"><FanAnyPageScreen /></div>;
}
