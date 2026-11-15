import type { TeamRoleKindWire, TeamRolesResponse } from "@agency_hub_core/contracts";
import { Card, Section } from "../components/Card.js";
import { Switch } from "../components/Field.js";
import { Skeleton } from "../components/Skeleton.js";
import { ErrorState } from "../components/States.js";
import type { RegistryPerson } from "./registry.js";

const KIND_WORDS: Record<TeamRoleKindWire, { label: string; hint: string }> = {
  lead: { label: "Ведёт команду", hint: "Решает споры о продажах команды, разбирает смены. Даёт владелец." },
  customs: { label: "Ведёт кастомы", hint: "Проверяет заказы кастомов модели и отдаёт их в съёмку." },
  view: { label: "Видит команду", hint: "Видит смены, продажи и разборы команды, работать на её страницах не может." },
};

const ALL_KINDS: readonly TeamRoleKindWire[] = ["lead", "customs", "view"];

/** One switch being saved. */
export interface TeamRoleChange {
  modelId: number;
  kind: TeamRoleKindWire;
  granted: boolean;
}

/**
 * «Команды и права» on a person's card (products package T): the person's records by model — «ведёт команду», «ведёт
 * кастомы», «видит команду». The model's lead grants and takes back the last two, the owner all three (Hub decides:
 * `teamRoleSet`). The teams a person is IN come from their working pages, not from here.
 *
 * One component, both products, the data handed in: Hub draws it for the owner (every kind), Workboard «Команда» for a
 * team lead (`kinds`: «ведёт кастомы» and «видит команду» on the lead's models). Each app reads `teamRoles` and writes
 * `teamRoleSet` with its own client.
 */
export function TeamRolesCard({ person, roles, failed, retrying = false, onRetry, saving, onSet, kinds = ALL_KINDS, title = "Команды и права" }: {
  person: Pick<RegistryPerson, "id" | "kind" | "state">;
  /** The answer of `teamRoles`; undefined while it comes. */
  roles: TeamRolesResponse | undefined;
  failed: boolean;
  retrying?: boolean;
  onRetry: () => void;
  /** The switch being saved now, if any. */
  saving: Pick<TeamRoleChange, "modelId" | "kind"> | null;
  onSet: (change: TeamRoleChange) => void;
  /** The records this card shows and changes. */
  kinds?: readonly TeamRoleKindWire[];
  /** null — no heading (the card is the tab's whole content). */
  title?: string | null;
}) {
  if (person.kind !== "human" || person.state === "left") return null;
  if (failed && !roles) return <Card><ErrorState compact onRetry={onRetry} retrying={retrying}>Команды не пришли.</ErrorState></Card>;
  if (!roles) return <Card><Skeleton width="50%" /></Card>;
  const has = (modelId: number, kind: TeamRoleKindWire) =>
    roles.records.some((record) => record.personId === person.id && record.modelId === modelId && record.kind === kind);
  const models = roles.models.filter((model) => model.canGrant || kinds.some((kind) => has(model.id, kind)));
  if (models.length === 0) return null;
  const card = (
    <Card>
      <ul className="ppl-team-roles">
        {models.map((model) => (
          <li key={model.id} className="ppl-team-roles__model">
            <span className="ppl-team-roles__name">
              {model.name}
              <span className="ppl-team-roles__lead">{model.leadName === null ? "ведёт владелец" : `ведёт ${model.leadName}`}</span>
            </span>
            <span className="ppl-team-roles__kinds">
              {kinds.map((kind) => {
                const may = kind === "lead" ? model.canGrantLead : model.canGrant;
                if (!may && !has(model.id, kind)) return null;
                return (
                  <Switch
                    key={kind}
                    label={KIND_WORDS[kind].label}
                    hint={KIND_WORDS[kind].hint}
                    checked={has(model.id, kind)}
                    disabled={!may}
                    pending={saving !== null && saving.modelId === model.id && saving.kind === kind}
                    onChange={(granted) => onSet({ modelId: model.id, kind, granted })}
                  />
                );
              })}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
  if (title === null) return card;
  return (
    <Section title={title} as="h3" description="Команда это модель: человек в команде модели своих рабочих страниц.">
      {card}
    </Section>
  );
}
