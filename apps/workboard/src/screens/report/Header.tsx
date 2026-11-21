import { Link } from "react-router";
import { Ico } from "./icons";
import { stepsOf, titleOf, whenOf } from "./model";
import type { BoardApi } from "./useBoard";

/**
 * The board's head: «Отчёт смены», the shift's date and hours, the quiet steps «Черновик · Проверка · Подтвердите ·
 * Учтён», and «Свернуть» in the frame (in a tab the way back to Workboard instead, asked for on 19.11).
 */
export function Header({ api }: { api: BoardApi }) {
  const { report, host, own, preview } = api;
  return (
    <header className="top">
      <div className="top-in">
        <div className="top-l">
          {host === "tab" && (
            <Link to="/" className="btn btn--quiet btn--sm top-back" title="Вернуться в Workboard"><Ico name="back" size={15} />На главную</Link>
          )}
          <div className="top-t">
            <h1>{titleOf(report.shift.personName, own)}</h1>
            <span className="top-d">{whenOf(report.shift)}</span>
          </div>
          {(!own || preview) && <span className="ro"><Ico name="lock" size={13} />{preview ? "Просмотр" : "Только чтение"}</span>}
        </div>
        {!preview && (
          <ol className="steps" aria-label="Этапы отчёта">
            {stepsOf(api.board.phase).map((step) => (
              <li key={step.label} className={`st is-${step.state}`} aria-current={step.state === "now" ? "step" : undefined}>
                <i aria-hidden="true" />{step.label}
              </li>
            ))}
          </ol>
        )}
        {host === "frame" && (
          <button type="button" className="btn btn--quiet btn--sm top-min" title="Свернуть доску в полосу внизу (Esc)" onClick={api.collapse}>
            <Ico name="min" size={15} />Свернуть
          </button>
        )}
      </div>
    </header>
  );
}
