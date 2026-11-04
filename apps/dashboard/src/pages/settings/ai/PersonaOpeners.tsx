import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
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
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { isUnknownOutcome, UNKNOWN_OUTCOME } from "../settingsFeedback.js";

// Hi's first messages of a persona (hub 0320, owner 2026-10-25): the texts Hi
// draws from on an empty chat, and how the fans each one went to answered. The
// persona is the path's key: every write goes to it.

type FanGroup = keyof AdminAiPersonaOpener["outcomes"];

const FAN_GROUPS: readonly { value: FanGroup; label: string }[] = [
  { value: "all", label: "Все фаны" },
  { value: "bare", label: "Пустой профиль" },
  { value: "named", label: "С именем" },
  { value: "other", label: "Остальные" },
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

function hoursText(hours: AdminAiPersonaOpener["hours"]): string | null {
  return hours === null ? null : `${hourLabel(hours.from)}–${hourLabel(hours.to)} (${zoneLabel(hours.timeZone)})`;
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
    <>
      <div className="whitespace-nowrap tabular-nums">
        {share.percent}{" "}% <span className="muted">{part} из {whole}</span>
      </div>
      {range && <div className="settings-second tabular-nums">{share.low}–{share.high}{" "}%</div>}
    </>
  );
}

function rateOf(outcome: AdminAiPersonaOpenerOutcome) {
  return outcome.matured === 0 ? -1 : outcome.replied / outcome.matured;
}

function quote(text: string) {
  return `«${text}»`;
}

/** «Первые сообщения»: the table of texts, the switch per text and the form of a new one. */
export function PersonaOpeners({ persona }: { persona: AdminAiPersona }) {
  const [search, setSearch] = useSearchParams();
  const asked = search.get("fans");
  const group: FanGroup = FAN_GROUPS.some((entry) => entry.value === asked) ? (asked as FanGroup) : "all";
  const { data, isLoading, isError, refetch } = useAdminAiPersonaOpeners(persona.key);
  const setEnabled = useAdminSetAiPersonaOpenerEnabled(persona.key);
  const [toggling, setToggling] = useState<AdminAiPersonaOpener | null>(null);
  const archived = persona.status !== "active";

  const openers = useMemo(() => {
    const list = [...(data?.openers ?? [])];
    // Best answered first; texts with nothing counted yet keep their order at the end.
    return list.sort((a, b) =>
      Number(b.enabled) - Number(a.enabled)
      || rateOf(b.outcomes[group]) - rateOf(a.outcomes[group])
      || a.id - b.id);
  }, [data, group]);

  const chooseGroup = (value: FanGroup) => {
    const next = new URLSearchParams(search);
    if (value === "all") next.delete("fans");
    else next.set("fans", value);
    setSearch(next, { replace: true });
  };

  function toggle(opener: AdminAiPersonaOpener) {
    setEnabled.mutate({ id: opener.id, enabled: !opener.enabled }, {
      onSuccess: () => {
        toast.success(opener.enabled ? "Текст выключен" : "Текст включён");
        setToggling(null);
      },
    });
  }

  const enabledCount = (data?.openers ?? []).filter((opener) => opener.enabled).length;

  let table;
  if (isLoading && !data) {
    table = <div className="card"><TableSkeleton rows={4} columns={6} /></div>;
  } else if (isError && !data) {
    table = (
      <StatusPanel
        tone="error"
        title="Hub не ответил"
        description="Тексты не пришли. Это не значит, что их нет."
        action={<button type="button" className="btn btn-sm" onClick={() => void refetch()}>Повторить</button>}
      />
    );
  } else if (openers.length === 0) {
    table = (
      <StatusPanel
        title="Текстов пока нет"
        description={archived ? "Персона в архиве: новые тексты добавить нельзя." : "Hi пишет первое сообщение сам, как раньше. Добавьте первый текст ниже."}
      />
    );
  } else {
    table = (
      <div className="card">
        <div className="table-wrap">
          <table className="data-table persona-openers-table">
            <thead>
              <tr>
                <th>Текст</th>
                <th>Включён</th>
                <th className="num">Отправили</th>
                <th className="num">Ответили за 72 ч</th>
                <th className="num">Разговорились</th>
                <th className="num">Оплатили за 14 дней</th>
              </tr>
            </thead>
            <tbody>
              {openers.map((opener) => {
                const outcome = opener.outcomes[group];
                const notes = [opener.audience === "bare" ? "только пустой профиль" : null, hoursText(opener.hours)].filter(Boolean);
                return (
                  <tr key={opener.id} title={`Текст №${opener.id}`}>
                    <td className="persona-opener-text">
                      <div className={opener.enabled ? undefined : "text-text-secondary"}>{opener.body}</div>
                      {notes.length > 0 && <div className="settings-second">{notes.join(", ")}</div>}
                    </td>
                    <td>
                      <Switch
                        checked={opener.enabled}
                        label={`Текст №${opener.id} включён`}
                        disabled={archived || setEnabled.isPending}
                        title={archived ? "Персона в архиве" : undefined}
                        onChange={() => { setEnabled.reset(); setToggling(opener); }}
                      />
                    </td>
                    <td className="num">
                      <div>{outcome.sent}</div>
                      {outcome.edited > 0 && <div className="settings-second">правили {outcome.edited}</div>}
                    </td>
                    <td className="num"><Share part={outcome.replied} whole={outcome.matured} range /></td>
                    <td className="num"><Share part={outcome.talked} whole={outcome.matured} /></td>
                    <td className="num"><Share part={outcome.paid} whole={outcome.maturedPaid} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <Segmented options={FAN_GROUPS} value={group} onChange={chooseGroup} label="Какие фаны" className="settings-segmented" />
      {table}
      {!archived && <AddOpenerForm persona={persona} />}
      <Disclosure>
        <p>Hi на пустом чате вытягивает один из включённых текстов по жребию. Фану без имени, фото и био текст уходит как есть, остальным ИИ добавляет имя или деталь профиля.</p>
        <p>Ответы считаются через 72 часа после отправки, оплаты через 14 дней. Под долей — её разброс: с вероятностью 95 % настоящая доля лежит в этих пределах.</p>
        <p>«Разговорились»: фан написал, страница ответила, фан написал снова.</p>
        <p>Текст нельзя изменить или удалить, только выключить и добавить новый: так цифры остаются за своими словами.</p>
      </Disclosure>

      {toggling && (
        <ConfirmModal
          title={toggling.enabled ? "Выключить текст?" : "Включить текст?"}
          message={quote(toggling.body)}
          facts={[
            { label: "Персона", value: persona.displayName },
            {
              label: "Что будет",
              value: toggling.enabled
                ? enabledCount <= 1
                  ? "Других включённых текстов нет: Hi начнёт писать первое сообщение сам"
                  : "Hi перестанет брать этот текст, цифры останутся за ним"
                : "Hi начнёт брать этот текст по жребию",
            },
            { label: "Отменить", value: "Можно: переключите обратно" },
          ]}
          confirmLabel={toggling.enabled ? "Выключить текст" : "Включить текст"}
          pendingLabel={toggling.enabled ? "Выключаем…" : "Включаем…"}
          tone="primary"
          error={setEnabled.error ? (isUnknownOutcome(setEnabled.error) ? `${UNKNOWN_OUTCOME} Обновите экран и проверьте переключатель.` : "Не удалось переключить текст.") : undefined}
          isPending={setEnabled.isPending}
          onConfirm={() => toggle(toggling)}
          onClose={() => setToggling(null)}
        />
      )}
    </div>
  );
}

function AddOpenerForm({ persona }: { persona: AdminAiPersona }) {
  const create = useAdminCreateAiPersonaOpener(persona.key);
  const [body, setBody] = useState("");
  const [bareOnly, setBareOnly] = useState(false);
  const [limitHours, setLimitHours] = useState(false);
  const [from, setFrom] = useState(10);
  const [to, setTo] = useState(22);
  const [zone, setZone] = useState(ZONES[0]!.zone);
  const [confirming, setConfirming] = useState(false);
  const sameHours = limitHours && from === to;

  function handleSubmit() {
    const input: AdminAiPersonaOpenerCreateBody = {
      body: body.trim(),
      audience: bareOnly ? "bare" : "any",
      hours: limitHours ? { from, to, timeZone: zone } : null,
    };
    create.mutate(input, {
      onSuccess: () => {
        toast.success("Текст добавлен");
        setBody("");
        setConfirming(false);
      },
    });
  }

  return (
    <section className="card" aria-labelledby="new-opener-title">
      <div className="card-header">
        <h2 id="new-opener-title" className="card-title">Новый текст</h2>
      </div>
      <div className="card-body persona-opener-form">
        <input
          aria-label="Текст первого сообщения"
          value={body}
          maxLength={500}
          onChange={(event) => setBody(event.target.value.replace(/[\r\n]+/g, " "))}
          placeholder="hey you, welcome ♡ so what are you up to today?"
          className="input"
        />
        <div className="persona-opener-options">
          <label className="persona-check">
            <input type="checkbox" checked={bareOnly} onChange={(event) => setBareOnly(event.target.checked)} />
            Только пустой профиль (ник user…, без имени, фото и био)
          </label>
          <label className="persona-check">
            <input type="checkbox" checked={limitHours} onChange={(event) => setLimitHours(event.target.checked)} />
            Только в часы
          </label>
          {limitHours && (
            <span className="persona-hours">
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
        <div className="persona-opener-submit">
          {sameHours && <span className="settings-header-reason">Начало и конец совпадают</span>}
          <button
            type="button"
            disabled={create.isPending || body.trim() === "" || sameHours}
            onClick={() => { create.reset(); setConfirming(true); }}
            className="btn btn-primary"
          >
            {create.isPending ? "Добавляем…" : "Добавить текст"}
          </button>
        </div>
      </div>
      {confirming && (
        <ConfirmModal
          title={`Добавить текст для ${persona.displayName}?`}
          message="Текст уйдёт фанам в первом сообщении Hi. Изменить его потом нельзя."
          facts={[
            { label: "Что именно", value: quote(body.trim()) },
            { label: "Кому", value: bareOnly ? "только пустой профиль" : "все фаны" },
            { label: "Когда", value: limitHours ? `${hourLabel(from)}–${hourLabel(to)} (${zoneLabel(zone)})` : "весь день" },
            { label: "Отменить", value: "Текст нельзя изменить или удалить, только выключить" },
          ]}
          confirmLabel="Добавить текст"
          pendingLabel="Добавляем…"
          tone="primary"
          error={create.error ? (isUnknownOutcome(create.error) ? `${UNKNOWN_OUTCOME} Обновите экран и проверьте список текстов.` : "Не удалось добавить текст.") : undefined}
          isPending={create.isPending}
          onConfirm={handleSubmit}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
