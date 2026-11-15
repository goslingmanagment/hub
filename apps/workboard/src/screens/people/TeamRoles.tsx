import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeamRoleKindWire } from "@agency_hub_core/contracts";
import { Card, ErrorState, Section, Skeleton, Switch, toast } from "@agency_hub_core/ui";
import { kernel } from "@/shared/hub";
import type { RegistryPerson } from "./teamPeople";

const KEY = ["team", "roles"] as const;

const KIND_WORDS: Record<TeamRoleKindWire, { label: string; hint: string }> = {
  lead: { label: "Ведёт команду", hint: "Решает споры о продажах команды, разбирает смены. Даёт владелец." },
  customs: { label: "Ведёт кастомы", hint: "Проверяет заказы кастомов модели и отдаёт их в съёмку." },
  view: { label: "Видит команду", hint: "Видит смены, продажи и разборы команды, работать на её страницах не может." },
};

/**
 * «Команды и права» on a person's card (products package T): the person's records by model — «ведёт команду», «ведёт
 * кастомы», «видит команду». The model's lead grants and takes back the last two, the owner all three (Hub decides:
 * `teamRoleSet`). The teams a person is IN come from their working pages, not from here.
 */
export function TeamRolesCard({ person }: { person: RegistryPerson }) {
  const queryClient = useQueryClient();
  const read = useQuery({ queryKey: KEY, queryFn: () => kernel.teamRoles() });
  const set = useMutation({
    mutationFn: (input: { modelId: number; kind: TeamRoleKindWire; granted: boolean }) =>
      kernel.teamRoleSet({ body: { personCode: person.code, ...input } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
    onError: () => toast.error("Не сохранилось. Попробуйте ещё раз."),
  });
  if (person.kind !== "human" || person.state === "left") return null;
  if (read.isPending) return <Card><Skeleton width="50%" /></Card>;
  if (read.isError) return <Card><ErrorState compact onRetry={() => void read.refetch()} retrying={read.isFetching}>Команды не пришли.</ErrorState></Card>;
  const has = (modelId: number, kind: TeamRoleKindWire) =>
    read.data.records.some((record) => record.personId === person.id && record.modelId === modelId && record.kind === kind);
  const models = read.data.models.filter((model) => model.canGrant || TEAM_KINDS.some((kind) => has(model.id, kind)));
  if (models.length === 0) return null;
  return (
    <Section title="Команды и права" as="h3" description="Команда это модель: человек в команде модели своих рабочих страниц.">
      <Card>
        <ul className="ppl-team-roles">
          {models.map((model) => (
            <li key={model.id} className="ppl-team-roles__model">
              <span className="ppl-team-roles__name">
                {model.name}
                <span className="ppl-team-roles__lead">{model.leadName === null ? "ведёт владелец" : `ведёт ${model.leadName}`}</span>
              </span>
              <span className="ppl-team-roles__kinds">
                {TEAM_KINDS.map((kind) => {
                  const may = kind === "lead" ? model.canGrantLead : model.canGrant;
                  if (!may && !has(model.id, kind)) return null;
                  return (
                    <Switch
                      key={kind}
                      label={KIND_WORDS[kind].label}
                      hint={KIND_WORDS[kind].hint}
                      checked={has(model.id, kind)}
                      disabled={!may}
                      pending={set.isPending && set.variables.modelId === model.id && set.variables.kind === kind}
                      onChange={(granted) => set.mutate({ modelId: model.id, kind, granted })}
                    />
                  );
                })}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}

const TEAM_KINDS: readonly TeamRoleKindWire[] = ["lead", "customs", "view"];
