import { mountContentScreen } from "./mount.js";

// «Публикации» inside ContentOps (products plan §2.4): the console's screen, alone.
mountContentScreen("publications", () => import("@/pages/publications/PublicationsPage").then((module) => module.PublicationsPage));
