// Regression: when `docker compose up` starts one service and then fails on another, the failure
// must hand back the services that did start, so a start-and-stop caller can stop them. The old
// code returned the bare `up` failure and dropped the list.
import { expect, test } from "bun:test";
import { type DockerResult, prepareCompose } from "../server/src/manager/compose";

const CONFIG = JSON.stringify({
  services: {
    db: { image: "postgres:16-alpine" },
    cache: { image: "docker.io/library/redis:7" },
  },
});

test("prepareCompose: an up that fails after starting a service still reports that service", async () => {
  const running = new Set<string>();
  const run = async (args: string[]): Promise<DockerResult> => {
    if (args.includes("config")) return { code: 0, stdout: CONFIG, stderr: "" };
    if (args.includes("ps")) {
      const lines = [...running].map((s) =>
        JSON.stringify({ Service: s, State: "running", Publishers: [] }),
      );
      return { code: 0, stdout: lines.join("\n"), stderr: "" };
    }
    if (args.includes("up")) {
      // db comes up; cache then fails.
      running.add("db");
      return { code: 1, stdout: "", stderr: "cache: port is already allocated" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const res = await prepareCompose({ services: ["db", "cache"] }, ".", {
    run,
    probe: async () => true,
    pollMs: 1,
  });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.reason).toContain("docker compose up failed");
    expect(res.started).toEqual(["db"]);
  }
});
