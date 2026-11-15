import { Link } from "react-router";
import { Badge, Card, EmptyState, Section } from "@agency_hub_core/ui";
import { liveLogins, type RegistryLogin, type RegistryPerson } from "@agency_hub_core/ui/people/registry";
import { whenWords } from "@agency_hub_core/ui/people/when";
import { ROLE_WORD } from "@agency_hub_core/ui/people/words";
import { PersonAccess } from "./PersonAccess";

/**
 * «Входы и устройства» (`part: "logins"`) and «Доступ к страницам» (`part: "pages"`) of a person's card in Hub
 * «Люди»: each of the person's Hub logins with everything Workboard's «Доступ» had for it — the sign-in link and the
 * password reset, devices, the AI limit, switching off and the other ways to end the access, deleting the account; or
 * its pages — through the very same panel (./PersonAccess.tsx): every control keeps its request and its question. An
 * agent's keys are listed on «Входы и устройства» and changed in «Система», «Агенты и ключи». A person without a login
 * (a content manager, a contractor) has nothing here.
 */
export function AccessTab({ person, part, onChanged }: { person: RegistryPerson; part: "logins" | "pages"; onChanged: () => void }) {
  const logins = liveLogins(person);
  const deleted = person.logins.filter((login) => login.state === "deleted");
  return (
    <div className="registry-tab">
      {person.kind === "agent" && part === "logins" && <AgentKeys person={person} />}
      {logins.length === 0 && person.kind !== "agent" && (
        <Card>
          <EmptyState title="Входа в Hub нет">
            {person.kind === "service" ? "Служебная запись без входа." : `${person.displayName} работает без расширения и Workboard: входить в Hub не нужно.`}
          </EmptyState>
        </Card>
      )}
      {logins.map((login) => (
        <Section
          key={login.userId}
          title={<span className="registry-login-title">Вход <span className="registry-code">{login.username}</span></span>}
          description={loginWords(login)}
          className="registry-login"
        >
          <PersonAccess userId={login.userId} variant="page" part={part} onChanged={onChanged} onDeleted={onChanged} />
        </Section>
      ))}
      {deleted.length > 0 && part === "logins" && (
        <p className="people-note">Удалённые входы: {deleted.map((login) => login.username).join(", ")}. Их история работы осталась за человеком.</p>
      )}
    </div>
  );
}

/** «Чаттер · в сети 24 мин назад», «Тимлид · ждёт регистрации», «Чаттер · доступ отключён». */
function loginWords(login: RegistryLogin): string {
  const role = ROLE_WORD[login.role];
  if (login.state === "invited") return `${role} · ждёт регистрации`;
  if (login.state === "disabled") return `${role} · доступ отключён`;
  return `${role} · ${login.lastSeenAt ? `в сети ${whenWords(login.lastSeenAt)}` : "входов ещё не было"}`;
}

function AgentKeys({ person }: { person: RegistryPerson }) {
  const STATE: Readonly<Record<string, { word: string; tone: "success" | "off" | "warning" }>> = {
    active: { word: "действует", tone: "success" },
    expired: { word: "истёк", tone: "warning" },
    revoked: { word: "отозван", tone: "off" },
  };
  return (
    <Card
      title={<>Ключи агента <span className="access-count">{person.agentKeys.length}</span></>}
      description="Выдают, продлевают и отзывают ключи в «Системе»."
      actions={<Link className="access-link" to="/system/agent-keys">Агенты и ключи</Link>}
    >
      {person.agentKeys.length === 0 ? <p className="access-text">Ключей нет.</p> : (
        <ul className="access-list">
          {person.agentKeys.map((key) => (
            <li key={key.agentKeyId} className="access-list__row">
              <span className="access-list__main">{key.name}</span>
              <Badge tone={STATE[key.state]?.tone ?? "off"} bare>{STATE[key.state]?.word ?? key.state}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
