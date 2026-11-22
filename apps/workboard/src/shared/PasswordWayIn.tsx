import { LogIn } from "lucide-react";
import { LEGACY_CONSOLE_ORIGIN, WORKBOARD_ORIGIN, teamOriginOf } from "@agency_hub_core/ui/sites";
import { inExtensionFrame, signInHref } from "./hub.js";

/**
 * In the extension's frame (Workboard's «Кастомы» over the site) there is no cookie and a sign-in page is never framed:
 * the way in opens in a tab, on Workboard's own name (the frame loads from the hub's root name in production), and
 * leads to the same screen there — the frame's path without `/frame`. A local build or the stand: its own name.
 */
function frameSignInHref(): string {
  const { origin, pathname, search } = window.location;
  const team = origin === LEGACY_CONSOLE_ORIGIN ? WORKBOARD_ORIGIN : teamOriginOf(origin) ?? origin;
  return `${team}${signInHref(`${pathname.replace("/frame/", "/")}${search}`)}`;
}

/**
 * A narrow session (opened from the extension, no password) does not change what needs the person's password behind
 * it: where they are paid, their devices and password (`NARROW_WEB_SESSION_PASSWORD_ONLY`). Where a screen of the
 * chatter's part would offer such a change, it shows this instead — never an error: the sign-in page of this site with
 * the password, and back to the same place.
 */
export function PasswordWayIn({ text = "Чтобы изменить, войдите на сайте с паролем." }: { text?: string }) {
  const framed = inExtensionFrame();
  return (
    <p className="wb-password-way">
      <span>{text}</span>{" "}
      <a
        className="ui-link wb-password-way__link"
        href={framed ? frameSignInHref() : signInHref()}
        {...(framed ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        <LogIn size={14} strokeWidth={1.75} aria-hidden />
        Войти с паролем
      </a>
    </p>
  );
}
