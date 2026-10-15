import { NotificationsReportsTab } from "../notifications/NotificationsReportsTab.js";
import { NotificationsSettingsTab } from "../notifications/NotificationsSettingsTab.js";

/** Telegram, what it is told, and the daily report — one settings screen.
 *  Incidents themselves are work, not settings: they live in «Требует внимания». */
export function NotificationsSettingsSection() {
  return (
    <div className="space-y-8">
      <NotificationsSettingsTab />
      <section aria-labelledby="daily-report-title">
        <h3 id="daily-report-title" className="section-title mb-3">Ежедневный отчёт</h3>
        <NotificationsReportsTab />
      </section>
    </div>
  );
}
