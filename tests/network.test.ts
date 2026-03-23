import { createServer } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { listenOnLoopback } from "./helpers/network.ts";

describe("listenOnLoopback", () => {
  it("keeps unrelated server error listeners intact after a successful bind", async (context) => {
    const server = createServer();
    const unrelatedErrorListener = vi.fn();
    server.on("error", unrelatedErrorListener);

    try {
      const address = await listenOnLoopback(server, "network helper tests");
      if (!address) {
        context.skip();
        return;
      }

      expect(server.listeners("error")).toContain(unrelatedErrorListener);

      server.emit("error", new Error("synthetic"));
      expect(unrelatedErrorListener).toHaveBeenCalledTimes(1);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
  });
});
