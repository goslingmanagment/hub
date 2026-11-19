import { useSearchParams } from "react-router";
import { FrameGate, useFramePort } from "@/shared/frame";
import { AskModal } from "./Questions";

/**
 * `/frame/ask?page=<page>&fan=<fan ref>&name=<fan's name>`: «Спросить» in the extension's frame over the site (products
 * package R5): Workboard's question window with the page and the fan filled in by the fan panel, the kinds about a fan.
 * The question goes to whoever decides (`teamQuestionAsk`, the team's lead, else the owner); its answer comes to «Ждут
 * вас» and to the extension's icon number. Asked, it says `done`; closed, `collapse`.
 */
export function FrameAskScreen() {
  const [search] = useSearchParams();
  const link = useFramePort({ client: true });
  const page = search.get("page") ?? "";
  const fan = search.get("fan") ?? "";
  const name = search.get("name");
  return (
    <FrameGate link={link} title="Спросить">
      {(transport) => (
        <AskModal
          start={{ kind: "discount_over_50", pageLabel: page, fan: { ref: fan, name: name === "" ? null : name } }}
          onAsked={() => transport.post({ t: "done", screen: "ask" })}
          onClose={() => transport.post({ t: "collapse" })}
        />
      )}
    </FrameGate>
  );
}
