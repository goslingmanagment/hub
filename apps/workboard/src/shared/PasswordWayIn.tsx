import { LogIn } from "lucide-react";
import { signInHref } from "./hub.js";

/**
 * A narrow session (opened from the extension, no password) does not change what needs the person's password behind
 * it: where they are paid, their devices and password (`NARROW_WEB_SESSION_PASSWORD_ONLY`). Where a screen of the
 * chatter's part would offer such a change, it shows this instead — never an error: the sign-in page of this site with
 * the password, and back to the same place.
 */
export function PasswordWayIn({ text = "Чтобы изменить, войдите на сайте с паролем." }: { text?: string }) {
  return (
    <p className="wb-password-way">
      <span>{text}</span>{" "}
      <a className="ui-link wb-password-way__link" href={signInHref()}>
        <LogIn size={14} strokeWidth={1.75} aria-hidden />
        Войти с паролем
      </a>
    </p>
  );
}
