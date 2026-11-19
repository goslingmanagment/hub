import { useSearchParams } from "react-router";
import { FrameGate, useFramePort } from "@/shared/frame";
import { RecordFromSaleModal } from "./index";

/**
 * `/frame/custom?page=<page>&fan=<fan ref>&name=<fan's name>`: «Записать кастом» in the extension's frame over the site
 * (products package R5): the board's own form with the page and the fan filled in by the fan panel. Its requests go
 * over the extension's port; recorded, it says `done` with the order's code (the fan panel shows the order at once);
 * closed, `collapse`.
 */
export function FrameCustomScreen() {
  const [search] = useSearchParams();
  const link = useFramePort({ client: true });
  const page = search.get("page") ?? "";
  const fan = search.get("fan") ?? "";
  const name = search.get("name");
  return (
    <FrameGate link={link} title="Записать кастом">
      {(transport) => (
        <div className="cus-frame">
          <RecordFromSaleModal
            page={page}
            fan={fan}
            {...(name === null || name === "" ? {} : { fanName: name })}
            fixedPage
            onRecorded={(code) => transport.post({ t: "done", screen: "custom", code })}
            onClose={() => transport.post({ t: "collapse" })}
          />
        </div>
      )}
    </FrameGate>
  );
}
