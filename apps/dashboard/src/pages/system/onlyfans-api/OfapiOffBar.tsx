import { createContext, useContext } from "react";
import { OfapiOffBanner, OfapiUnknownNotice, type OfapiView } from "../shared.js";

/**
 * Inside the one screen «OnlyFans API» the switch is said once, above every
 * section (OnlyfansApiScreen): a section's own bar says only its extra sentence.
 */
export const OfapiSaidAbove = createContext(false);

/**
 * The one notice right under the tabs of every OnlyFans API tab but «Состояние»
 * (design/screens/system.md §7). A team lead does not know the switch and sees none.
 */
export function OfapiOffBar({ ofapi, detail }: { ofapi: OfapiView; detail?: string | undefined }) {
  const said = useContext(OfapiSaidAbove);
  if (said) return ofapi.status === "off" && detail ? <p className="text-sm text-text-secondary">{detail}</p> : null;
  if (ofapi.status === "off") {
    return (
      <OfapiOffBanner>
        Кнопки записи отключены. Данные на экране — по 1 ноября.{detail ? <span className="block text-text-secondary">{detail}</span> : null}
      </OfapiOffBanner>
    );
  }
  return <OfapiUnknownNotice ofapi={ofapi} />;
}
