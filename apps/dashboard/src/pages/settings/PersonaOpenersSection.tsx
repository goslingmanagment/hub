import { useMemo, useState } from "react";
import type {
  AdminAiPersona,
  AdminAiPersonaOpener,
  AdminAiPersonaOpenerCreateBody,
  AdminAiPersonaOpenerOutcome,
} from "@agency_hub_core/contracts";
import { toast } from "sonner";

import {
  useAdminAiPersonaOpeners,
  useAdminCreateAiPersonaOpener,
  useAdminSetAiPersonaOpenerEnabled,
} from "@/api/queries";
import { FilterButtons } from "@/components/shared/FilterButtons";

// Hi's first messages of a persona (hub 0320, owner 2026-10-25): the texts Hi
// draws from on an empty chat, and how the fans each one went to answered.

type FanGroup = keyof AdminAiPersonaOpener["outcomes"];

const FAN_GROUPS: { key: FanGroup; label: string }[] = [
  { key: "all", label: "Все фаны" },
  { key: "bare", label: "Пустой профиль" },
  { key: "named", label: "С именем" },
  { key: "other", label: "Остальные" },
];

const ZONES: { zone: string; label: string }[] = [
  { zone: "Europe/Warsaw", label: "Польша" },
  { zone: "Europe/Minsk", label: "Минск" },
  { zone: "Europe/Moscow", label: "Москва" },
  { zone: "UTC", label: "UTC" },
];

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function zoneLabel(zone: string) {
  return ZONES.find((entry) => entry.zone === zone)?.label ?? zone;
}

function hourLabel(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** The share and its 95% range (Wilson), in whole percent. */
function shareOf(part: number, whole: number) {
  if (whole === 0) return null;
  const z = 1.96;
  const p = part / whole;
  const denominator = 1 + (z * z) / whole;
  const center = (p + (z * z) / (2 * whole)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / whole + (z * z) / (4 * whole * whole))) / denominator;
  return {
    percent: Math.round(p * 100),
    low: Math.max(0, Math.round((center - half) * 100)),
    high: Math.min(100, Math.round((center + half) * 100)),
  };
}

function Share({ part, whole, range = false }: { part: number; whole: number; range?: boolean }) {
  const share = shareOf(part, whole);
  if (share === null) return <span className="muted">—</span>;
  return (
    <div>
      <div className="whitespace-nowrap tabular-nums">
        {share.percent}% <span className="muted text-xs">· {part} из {whole}</span>
      </div>
      {range && whole > 0 && (
        <div className="text-xs text-text-secondary tabular-nums">{share.low}–{share.high}%</div>
      )}
    </div>
  );
}

function rateOf(outcome: AdminAiPersonaOpenerOutcome) {
  return outcome.matured === 0 ? -1 : outcome.replied / outcome.matured;
}

/** Which persona to open first: one the owner made, else the first. */
function firstPersona(personas: AdminAiPersona[]) {
  const active = personas.filter((persona) => persona.status === "active");
  return (active.find((persona) => !persona.key.startsWith("builtin:")) ?? active[0])?.key ?? null;
}

export function PersonaOpenersSection({ personas }: { personas: AdminAiPersona[] }) {
  const active = personas.filter((persona) => persona.status === "active");
  const [personaKey, setPersonaKey] = useState<string | null>(() => firstPersona(personas));
  const [group, setGroup] = useState<FanGroup>("all");
  const { data, isLoading, isError, error } = useAdminAiPersonaOpeners(personaKey);
  const setEnabled = useAdminSetAiPersonaOpenerEnabled(personaKey ?? "");

  const openers = useMemo(() => {
    const list = [...(data?.openers ?? [])];
    // Best answered first; texts with nothing counted yet keep their order at the end.
    return list.sort((a, b) =>
      Number(b.enabled) - Number(a.enabled)
      || rateOf(b.outcomes[group]) - rateOf(a.outcomes[group])
      || a.id - b.id);
  }, [data, group]);

  async function toggle(opener: AdminAiPersonaOpener) {
    try {
      await setEnabled.mutateAsync({ id: opener.id, enabled: !opener.enabled });
      toast.success(opener.enabled ? "Текст выключен" : "Текст включён");
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Не удалось переключить текст");
    }
  }

  if (active.length === 0) return null;

  return (
    <section className="card" aria-labelledby="persona-openers-title">
      <div className="card-header">
        <div>
          <h3 id="persona-openers-title" className="card-title">Первые сообщения для Hi</h3>
          <p className="card-description">
            Hi на пустом чате вытягивает один из включённых текстов по жребию. Фану без имени, фото и био текст уходит
            как есть, остальным AI добавляет имя или деталь профиля. Ответы считаются через 72 часа после отправки,
            оплаты через 14 дней; серым под долей её разброс.
          </p>
        </div>
      </div>
      <div className="card-body space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {active.length > 1 && (
            <select
              aria-label="Персона"
              value={personaKey ?? ""}
              onChange={(event) => setPersonaKey(event.target.value)}
              className="select w-auto min-w-[200px]"
            >
              {active.map((persona) => (
                <option key={persona.key} value={persona.key}>{persona.displayName}</option>
              ))}
            </select>
          )}
          <FilterButtons
            filters={FAN_GROUPS.map((entry) => ({ key: entry.key, label: entry.label }))}
            active={group}
            onChange={(key) => setGroup(key as FanGroup)}
          />
        </div>

        {isLoading && !data ? (
          <div role="status" className="py-6 text-center text-sm text-text-secondary">Загружаем тексты…</div>
        ) : isError && !data ? (
          <p className="text-sm text-danger">
            {error instanceof Error ? error.message : "Не удалось загрузить тексты."}
          </p>
        ) : openers.length === 0 ? (
          <p className="text-sm text-text-secondary">
            Текстов пока нет: Hi пишет первое сообщение сам, как раньше. Добавьте первый текст ниже.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Текст</th>
                  <th className="num">Отправили</th>
                  <th>Ответили за 72 ч</th>
                  <th>Разговор</th>
                  <th>Оплатили за 14 дн</th>
                </tr>
              </thead>
              <tbody>
                {openers.map((opener) => {
                  const outcome = opener.outcomes[group];
                  return (
                    <tr key={opener.id} className={opener.enabled ? undefined : "opacity-60"}>
                      <td className="min-w-[260px] max-w-[460px]">
                        <div className="whitespace-normal">{opener.body}</div>
                        <div className="flex flex-wrap items-center gap-x-1 text-xs text-text-secondary">
                          <span>
                            №{opener.id}
                            {opener.audience === "bare" && " · только пустой профиль"}
                            {opener.hours !== null
                              && ` · ${hourLabel(opener.hours.from)}–${hourLabel(opener.hours.to)} (${zoneLabel(opener.hours.timeZone)})`}
                            {!opener.enabled && " · выключен"}
                            {" · "}
                          </span>
                          <button
                            type="button"
                            disabled={setEnabled.isPending}
                            onClick={() => void toggle(opener)}
                            className="text-xs underline decoration-dotted underline-offset-2 hover:text-text-primary disabled:opacity-50"
                          >
                            {opener.enabled ? "выключить" : "включить"}
                          </button>
                        </div>
                      </td>
                      <td className="num">
                        <div className="tabular-nums">{outcome.sent}</div>
                        {outcome.edited > 0 && (
                          <div className="text-xs text-text-secondary tabular-nums">правили {outcome.edited}</div>
                        )}
                      </td>
                      <td><Share part={outcome.replied} whole={outcome.matured} range /></td>
                      <td><Share part={outcome.talked} whole={outcome.matured} /></td>
                      <td><Share part={outcome.paid} whole={outcome.maturedPaid} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {personaKey !== null && <AddOpenerForm key={personaKey} personaKey={personaKey} />}
      </div>
    </section>
  );
}

function AddOpenerForm({ personaKey }: { personaKey: string }) {
  const create = useAdminCreateAiPersonaOpener(personaKey);
  const [body, setBody] = useState("");
  const [bareOnly, setBareOnly] = useState(false);
  const [limitHours, setLimitHours] = useState(false);
  const [from, setFrom] = useState(10);
  const [to, setTo] = useState(22);
  const [zone, setZone] = useState(ZONES[0]!.zone);

  async function handleSubmit() {
    const input: AdminAiPersonaOpenerCreateBody = {
      body: body.trim(),
      audience: bareOnly ? "bare" : "any",
      hours: limitHours ? { from, to, timeZone: zone } : null,
    };
    try {
      await create.mutateAsync(input);
      toast.success("Текст добавлен");
      setBody("");
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Не удалось добавить текст");
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <label htmlFor="opener-body" className="field-label">Новый текст</label>
      <input
        id="opener-body"
        value={body}
        maxLength={500}
        onChange={(event) => setBody(event.target.value.replace(/[\r\n]+/g, " "))}
        placeholder="hey you, welcome ♡ so what are you up to today?"
        className="input"
      />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={bareOnly} onChange={(event) => setBareOnly(event.target.checked)} className="accent-accent" />
          Только пустой профиль (ник user…, без имени, фото и био)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={limitHours} onChange={(event) => setLimitHours(event.target.checked)} className="accent-accent" />
          Только в часы
        </label>
        {limitHours && (
          <span className="flex flex-wrap items-center gap-2">
            с
            <select aria-label="С какого часа" value={from} onChange={(event) => setFrom(Number(event.target.value))} className="select w-auto">
              {HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
            </select>
            до
            <select aria-label="До какого часа" value={to} onChange={(event) => setTo(Number(event.target.value))} className="select w-auto">
              {HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
            </select>
            <select aria-label="Часовой пояс" value={zone} onChange={(event) => setZone(event.target.value)} className="select w-auto">
              {ZONES.map((entry) => <option key={entry.zone} value={entry.zone}>{entry.label}</option>)}
            </select>
          </span>
        )}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          disabled={create.isPending || body.trim() === "" || (limitHours && from === to)}
          onClick={() => void handleSubmit()}
          className="btn btn-primary"
        >
          {create.isPending ? "Добавляем…" : "Добавить текст"}
        </button>
      </div>
    </div>
  );
}
