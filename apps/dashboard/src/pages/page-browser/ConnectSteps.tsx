import { Check, Circle, CircleDot } from "lucide-react";

export type ConnectStepState = "done" | "current" | "locked";

const STEPS = ["Прокси", "Браузер на сервере", "Выходной IP", "Вход", "Страница"] as const;

/**
 * The five steps of connecting a Fansly page, the same strip on both screens: a
 * check for a done one, a ring for the current one, the closed ones quiet. The
 * current one is the main text with a line under it, not the accent.
 */
export function ConnectSteps({ states }: { states: readonly ConnectStepState[] }) {
  return (
    <ol className="connect-steps" aria-label="Шаги подключения">
      {STEPS.map((label, index) => {
        const state = states[index] ?? "locked";
        const Icon = state === "done" ? Check : state === "current" ? CircleDot : Circle;
        return (
          <li key={label} className={`connect-step connect-step-${state}`} aria-current={state === "current" ? "step" : undefined}>
            <Icon size={16} aria-hidden="true" />
            <span>{index + 1}. {label}</span>
          </li>
        );
      })}
    </ol>
  );
}
