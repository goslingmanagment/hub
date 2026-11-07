import { ScreenHeader } from "@/shared/ScreenHeader";
import { ScreenStub } from "@/shared/ScreenStub";

/** Доступ (spec §4.8): invite, people × pages, links and devices. The owner's only. */
export function AccessScreen() {
  return (
    <>
      <ScreenHeader title="Доступ" />
      <div className="wb-content">
        <ScreenStub title="Доступ">
          Пригласить человека, кому какие страницы открыты, ссылки и устройства, отключение.
        </ScreenStub>
      </div>
    </>
  );
}
