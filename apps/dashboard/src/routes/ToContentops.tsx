import { useLayoutEffect, useState } from "react";
import { useLocation } from "react-router";

/**
 * «Публикации» and «Статистика → Контент» are ContentOps' screens (products package C2). Hub's server answers their
 * addresses (`/contentops/<screen>` and the old ones: services/content-screens-moved.ts): ContentOps signed in, or
 * words why not. Reached inside the console (a link, a legacy rule), the address is loaded from the server once; a
 * second time in a row means no server answered it (a local build without Hub's server) and is said, never looped.
 */
export function ToContentops() {
  const { pathname, search, hash } = useLocation();
  const address = `${pathname}${search}${hash}`;
  const [stuck, setStuck] = useState(false);
  useLayoutEffect(() => {
    const key = "hub:to-contentops";
    let last: string | null = null;
    try {
      last = sessionStorage.getItem(key);
      sessionStorage.setItem(key, `${address} ${Date.now()}`);
    } catch {
      last = null;
    }
    const [lastAddress, lastAt] = (last ?? "").split(" ");
    if (lastAddress === address && Date.now() - Number(lastAt) < 5_000) {
      setStuck(true);
      return;
    }
    window.location.replace(address);
  }, [address]);
  return (
    <div role="status" className="flex items-center justify-center h-full py-20 text-text-muted">
      {stuck ? "Публикации и статистика контента живут в ContentOps: откройте его." : "Открываем ContentOps…"}
    </div>
  );
}

