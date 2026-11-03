import { createContext, useContext } from "react";

/**
 * How a screen reaches the header its frame draws. The frame (section, page
 * card) owns the title, the page chip and the period; a screen knows its dates,
 * its main button and, on a deep screen, its own name. `<PageHeader>` inside the
 * frame hands these over by portal, so the header reads as one line and the
 * screen stays where its data is.
 */
export interface ScreenFrame {
  /**
   * `section`: the header belongs to the section, a screen's title and sentence
   * are dropped. `deep`: the screen is the object, its title goes into the
   * header. `inline`: the frame's header is about something else (a page's
   * card), the screen keeps a smaller heading of its own.
   */
  mode: "section" | "deep" | "inline";
  slots: {
    title: HTMLElement | null;
    subtitle: HTMLElement | null;
    actions: HTMLElement | null;
    window: HTMLElement | null;
  };
}

export const ScreenFrameContext = createContext<ScreenFrame | null>(null);

export function useScreenFrame(): ScreenFrame | null {
  return useContext(ScreenFrameContext);
}
