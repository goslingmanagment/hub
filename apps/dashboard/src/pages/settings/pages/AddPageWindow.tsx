import { useNavigate } from "react-router";
import { ChevronRight } from "lucide-react";
import { ModalShell } from "@/components/shared/ModalShell";
import { browserDraftRoute } from "@/lib/navigation";
import { OFAPI_OFF_REASON, OFAPI_UNKNOWN_REASON, type OfapiStatus } from "@/lib/statusWords";

/**
 * «Добавить страницу»: the platform first. Fansly is only a move to the connecting
 * screen; OnlyFans opens its form, and only while its API is on (ia.md §0, п. 11).
 */
export function AddPageWindow({ ofapi, onClose, onChooseOnlyFans }: {
  ofapi: OfapiStatus;
  onClose: () => void;
  onChooseOnlyFans: () => void;
}) {
  const navigate = useNavigate();
  const onlyFansBlocked = ofapi === "off" ? `${OFAPI_OFF_REASON}.` : ofapi === "unknown" ? `${OFAPI_UNKNOWN_REASON}.` : null;
  const options: { title: string; text: string; disabled: boolean; action: () => void }[] = [
    {
      title: "Fansly",
      text: "Вставьте прокси: Hub сам войдёт в аккаунт в отдельном браузере.",
      disabled: false,
      action: () => navigate(browserDraftRoute()),
    },
    {
      title: "OnlyFans",
      text: onlyFansBlocked ?? "Подключите аккаунт в OnlyFans API, затем укажите здесь его имя на OnlyFans.",
      disabled: onlyFansBlocked !== null,
      action: onChooseOnlyFans,
    },
  ];
  return (
    <ModalShell title="Добавить страницу" onClose={onClose} size="short">
      <div className="settings-options" role="list">
        {options.map((option) => (
          <button
            key={option.title}
            type="button"
            role="listitem"
            className="option-row"
            disabled={option.disabled}
            onClick={option.action}
          >
            <span className="min-w-0 flex-1">
              <span className="option-row-title">{option.title}</span>
              <span className="option-row-text">{option.text}</span>
            </span>
            {!option.disabled && <ChevronRight size={18} aria-hidden="true" className="option-row-chevron" />}
          </button>
        ))}
      </div>
    </ModalShell>
  );
}
