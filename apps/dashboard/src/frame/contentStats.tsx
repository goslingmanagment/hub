import { prefetchPages } from "@/api/pages";
import { mountContentScreen } from "./mount.js";

// «Статистика» inside ContentOps (products plan §2.4): the console's «Контент» of a page's Fansly statistics, alone.
// It waits for the page catalog before anything: asked for at once.
prefetchPages();
mountContentScreen("stats", () => import("@/pages/stats/StatsContentPage").then((module) => module.StatsContentPage));
