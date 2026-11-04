import { OfapiOffBanner, OfapiUnknownNotice, type OfapiView } from "../shared.js";

/**
 * The one notice right under the tabs of every OnlyFans API tab but «Состояние»
 * (design/screens/system.md §7). A team lead does not know the switch and sees none.
 */
export function OfapiOffBar({ ofapi, detail }: { ofapi: OfapiView; detail?: string | undefined }) {
  if (ofapi.status === "off") {
    return (
      <OfapiOffBanner>
        Кнопки записи отключены. Данные на экране — по 1 ноября.{detail ? <span className="block text-text-secondary">{detail}</span> : null}
      </OfapiOffBanner>
    );
  }
  return <OfapiUnknownNotice ofapi={ofapi} />;
}
