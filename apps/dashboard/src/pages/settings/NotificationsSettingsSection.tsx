import { NotificationsReportsTab } from "../notifications/NotificationsReportsTab.js";
import { NotificationsSettingsTab } from "../notifications/NotificationsSettingsTab.js";

/** Telegram, what it is told, and the daily report — one settings screen.
 *  Incidents themselves are work, not settings: they live in «Требует внимания». */
export function NotificationsSettingsSection() {
  return (
    <div className="space-y-5">
      <NotificationsSettingsTab />
      <NotificationsReportsTab />
    </div>
  );
}
