import type { ReactNode } from "react";
import { Notice } from "./Notice.js";

/** The sentence over what the switched-off OnlyFans API left behind. */
export function OfapiOffNotice({ children }: { children?: ReactNode }) {
  return (
    <Notice tone="off">
      <b>OnlyFans API выключен с 1 ноября.</b> {children}
    </Notice>
  );
}
