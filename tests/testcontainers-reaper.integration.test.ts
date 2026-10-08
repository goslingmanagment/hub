import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";

import { getContainerRuntimeClient } from "testcontainers";
import { afterEach, describe, expect, it } from "vitest";

import { acquireTestPrerequisite } from "./helpers/prerequisites.ts";

const OWN_REAPER = "TESTCONTAINERS_RYUK_TEST_LABEL";
const REAPER = "org.testcontainers.ryuk";
const SESSION = "org.testcontainers.session-id";

type Reaper = { containerId: string };
type ReaperModule = { getReaper(client: unknown): Promise<Reaper> };

/** A fresh copy of Testcontainers' reaper module: it keeps one reaper per
 * module, and this file asks it twice. Its internals are what the switch
 * rests on; an upgrade that moves them fails here, as it should. */
function freshReaperModule(): ReaperModule {
  const require = createRequire(import.meta.url);
  const file = path.join(path.dirname(require.resolve("testcontainers")), "reaper", "reaper.js");
  delete require.cache[file];
  return require(file) as ReaperModule;
}

/** The fields of a running reaper container that Testcontainers reads from a listing. */
function reaperListing(id: string, created: number, port: number, own: boolean) {
  return {
    Id: id,
    Created: created,
    State: "running",
    Labels: { [REAPER]: "true", [SESSION]: `session-of-${id}`, ...(own ? { [OWN_REAPER]: "true" } : {}) },
    Ports: [{ PrivatePort: 8080, PublicPort: port, Type: "tcp" }],
  };
}

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  // The reaper module keeps its connection open; a server closes only once its connections have.
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

/** A local port standing in for a reaper: it counts who connects. */
async function fakeReaperPort() {
  const connections: string[] = [];
  const server = createServer(socket => {
    connections.push("connected");
    sockets.push(socket);
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, connections };
}

// tests/helpers/global-setup.ts gives every test process a reaper (Ryuk) of its
// own through a Testcontainers variable meant for its own tests and not
// documented. A reaper shared on the PC's Docker daemon removed running
// shards' clusters, so this file fails when the switch no longer reaches a
// test process, or when an upgrade stops doing either half of what it rests on.
describe("a Testcontainers reaper of its own for every test process", () => {
  it("is switched on in the test process", () => {
    // Global setup sets it in the main process; the workers start after it.
    expect(process.env[OWN_REAPER]).toBe("true");
  });

  it("never takes a running reaper that carries the label, even the newest", async () => {
    const own = await fakeReaperPort();
    const shared = await fakeReaperPort();
    const client = {
      container: { list: async () => [reaperListing("own", 2, own.port, true), reaperListing("shared", 1, shared.port, false)] },
      info: { containerRuntime: { host: "127.0.0.1", remoteSocketPath: "/var/run/docker.sock" } },
    };

    const reaper = await freshReaperModule().getReaper(client);

    expect(reaper.containerId).toBe("shared");
    expect(own.connections).toEqual([]);
  });

  it("labels the reaper it starts under the switch", async () => {
    const runtime = await acquireTestPrerequisite(() => getContainerRuntimeClient(), {
      prerequisite: "Docker",
      reason: "A reaper is a container on the Docker daemon.",
    });
    if (runtime === null) return;
    // No reaper offered: whatever runs on this daemon, the module starts one.
    const client = { container: { list: async () => [] }, info: runtime.info };

    const reaper = await freshReaperModule().getReaper(client);

    const container = runtime.container.dockerode.getContainer(reaper.containerId);
    try {
      expect((await container.inspect()).Config.Labels[OWN_REAPER]).toBe("true");
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  });
});
