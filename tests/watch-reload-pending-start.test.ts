// Regression: a watch reload that changes a process's executable config must not run the NEW
// command from a start that was already queued or waiting. The user has to start it explicitly.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { expect, test } from "bun:test";
import net from "node:net";
import { Manager } from "../server/src/manager";
import type { LoadedProject, ProcessDef } from "../server/src/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(stepMs);
  }
}

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, () => resolve(srv));
  });
}

function freePort(): Promise<number> {
  return listenOn(0).then(
    (srv) =>
      new Promise<number>((resolve) => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      }),
  );
}

const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
const keepAliveCommand = () =>
  `${quote(process.execPath)} -e ${quote("setInterval(() => {}, 1000)")}`;

function project(processes: ProcessDef[]): LoadedProject {
  return {
    id: "watchpend",
    name: "watchpend",
    path: `${import.meta.dir}\\watchpend.devwebui`,
    dir: import.meta.dir,
    processes,
  };
}

test("a watch reload that changes the command of a pending start never spawns the new command", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const port = await freePort();
  const def = (command: string): ProcessDef => ({
    id: "watchpend.web",
    name: "web",
    command,
    cwd: import.meta.dir,
    autostart: false,
    projectId: "watchpend",
    projectName: "watchpend",
    waitForPort: port,
  });
  manager.waitForPortPollMs = 40;
  manager.waitForPortTimeoutMs = 10000;
  manager.addProject(project([def(keepAliveCommand())]), { autostart: false });
  let dep: net.Server | null = null;
  try {
    manager.start("watchpend.web");
    await waitFor(() => manager.view("watchpend.web")?.status === "waiting");

    // The file changes on disk while the start is still waiting for its port.
    const changed = keepAliveCommand().replace("setInterval", "setInterval /* changed */");
    manager.reconcileProject(project([def(changed)]), { fromWatch: true });

    // The port opens after the reload: the OLD code would now spawn the new command.
    dep = await listenOn(port);
    await sleep(800);
    const view = manager.view("watchpend.web");
    expect(view?.status).not.toBe("running");
    expect(view?.pid).toBeNull();
  } finally {
    dep?.close();
    await manager.stopProject("watchpend");
    manager.dispose();
  }
}, 15000);
