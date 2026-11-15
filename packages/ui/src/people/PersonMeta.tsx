import type { ReactNode } from "react";
import { Badge } from "../components/Badge.js";
import { lastSeenOf, liveLogins, slotSummary, type RegistryPerson } from "./registry.js";
import { whenWords } from "./when.js";
import { capitalized, PERSON_ROLE_WORD, PERSON_STATE_WORD } from "./words.js";

/** The registry's state of a person as the header's first word: «Работает», «Приглашён», «Ушёл». */
export function PersonStateBadge({ person }: { person: Pick<RegistryPerson, "state"> }) {
  return (
    <Badge tone={person.state === "left" ? "off" : person.state === "invited" ? "info" : "neutral"} bare>
      {capitalized(PERSON_STATE_WORD[person.state] ?? person.state)}
    </Badge>
  );
}

/**
 * Who a person is, one line under the name on every tab of their card, in both products: the state (or, in Workboard,
 * the shift going on — `status`), the role, the code, the working pages, the slot and the last time any of the logins
 * was seen.
 */
export function PersonMeta({ person, status }: {
  person: RegistryPerson;
  /** The first part; absent — the registry's state. */
  status?: ReactNode;
}) {
  const logins = liveLogins(person);
  const parts: ReactNode[] = [status ?? <PersonStateBadge key="status" person={person} />];
  parts.push(<span key="role">{PERSON_ROLE_WORD[person.role] ?? person.role}</span>);
  parts.push(<code key="code" className="registry-code">{person.code}</code>);
  if (person.workingPages.length > 0) {
    const labels = person.workingPages.map((page) => page.pageLabel);
    parts.push(<span key="pages" className="ui-page">{labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 2).join(", ")} и ещё ${labels.length - 2}`}</span>);
  }
  const slot = slotSummary(person);
  if (slot.hours) parts.push(<span key="slot">{slot.hours} по Москве{slot.days ? `, ${slot.days}` : ""}</span>);
  const seen = lastSeenOf(person);
  if (logins.length > 0) parts.push(<span key="seen">{seen ? `в сети ${whenWords(seen)}` : "входов не было"}</span>);
  return (
    <div className="people-meta">
      {parts.map((part, index) => (
        <span key={index} className="people-meta__part">
          {index > 0 && <span className="people-meta__sep" aria-hidden>·</span>}
          {part}
        </span>
      ))}
    </div>
  );
}
