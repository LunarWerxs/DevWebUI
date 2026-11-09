// Regression: a port-wait continuation from a run that was stopped must not change the NEW run
// started on the same entry. Stop then start re-sets pendingStart on the same entry, so the
// old wait's timeout used to mark the new run "stopped" and cancel it.
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

test("a port wait from a stopped run cannot time out the restarted run on the same entry", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const port = await freePort(); // nothing listens: the first wait runs out its timeout
  const processDef: ProcessDef = {
    id: "portgen.web",
    name: "web",
    command: keepAliveCommand(),
    cwd: import.meta.dir,
    autostart: false,
    projectId: "portgen",
    projectName: "portgen",
    waitForPort: port,
  };
  const project: LoadedProject = {
    id: "portgen",
    name: "portgen",
    path: `${import.meta.dir}\\portgen.devwebui`,
    dir: import.meta.dir,
    processes: [processDef],
  };
  manager.waitForPortPollMs = 40;
  manager.waitForPortTimeoutMs = 300;
  manager.addProject(project, { autostart: false });
  let dep: net.Server | null = null;
  try {
    manager.start("portgen.web");
    await waitFor(() => manager.view("portgen.web")?.status === "waiting");
    await manager.stop("portgen.web"); // cancels the first run's pending wait
    manager.waitForPortTimeoutMs = 5000; // the restarted run waits much longer
    manager.start("portgen.web");
    await waitFor(() => manager.view("portgen.web")?.status === "waiting");

    // Past the first wait's 300 ms deadline: the old callback must not have touched the new run.
    await sleep(600);
    expect(manager.view("portgen.web")?.status).toBe("waiting");
    expect(manager.view("portgen.web")?.waitingOnPort).toBe(port);

    dep = await listenOn(port);
    await waitFor(() => manager.view("portgen.web")?.status === "running", 5000);
  } finally {
    dep?.close();
    await manager.stopProject("portgen");
    manager.dispose();
  }
}, 15000);
