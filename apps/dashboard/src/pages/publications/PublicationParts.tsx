import { Link } from "react-router";
import { pageState, type PublicationPageSettings } from "./publicationsView.js";

/** Where the global switch is changed: its line in Settings → «Все параметры». */
export const GLOBAL_SWITCH_HREF = "/settings?tab=configuration#config-publishingEnabled";

const STATE_DOTS = { ok: "status-dot status-dot-ok", off: "status-dot", stopped: "status-dot status-dot-error" } as const;
const STATE_TEXT = { ok: "text-text-primary", off: "text-text-muted", stopped: "font-medium text-danger" } as const;

/** A page's publishing: on, off, or stopped by Hub. */
export function PageStateMark({ settings }: { settings: Pick<PublicationPageSettings, "enabled" | "autostopReason"> }) {
  const state = pageState(settings);
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${STATE_TEXT[state.tone]}`}>
      <span className={STATE_DOTS[state.tone]} aria-hidden="true" />
      {state.label}
    </span>
  );
}

/**
 * The global switch `publishingEnabled`: above every page's own. Off — no page
 * publishes, whatever its own switch says. It is changed in Settings, not here.
 */
export function GlobalSwitchLine({ enabled }: { enabled: boolean }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
      <span className={enabled ? "status-dot status-dot-ok" : "status-dot"} aria-hidden="true" />
      <span className="font-medium text-text-primary">
        {enabled ? "Общий выключатель включён" : "Общий выключатель выключен"}
      </span>
      <span>
        {enabled
          ? "— Hub публикует на страницах, где публикация включена."
          : "— Hub ничего не публикует ни на одной странице, что бы ни стояло у страниц."}
      </span>
      <Link to={GLOBAL_SWITCH_HREF} className="link">
        Меняется в настройках: «Публикация постов через Hub»
      </Link>
    </p>
  );
}
