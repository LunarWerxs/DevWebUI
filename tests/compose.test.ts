// Compose-managed dependencies (manager/compose.ts): pins the contract a `.devwebui`
// `compose` block promises without needing a Docker daemon: `up` is skipped when the
// stack already runs, services labelled devwebui.ignore are never started or mapped,
// only services this call started are reported for a later stop, and a published
// Postgres/Redis yields DATABASE_URL/REDIS_URL pointing at the HOST port.
import { expect, test } from "bun:test";
import {
  type ComposeService,
  connectionEnv,
  type DockerResult,
  imageName,
  parseComposePs,
  prepareCompose,
} from "../server/src/manager/compose";

const CONFIG = JSON.stringify({
  services: {
    db: {
      image: "postgres:16-alpine",
      environment: {
        POSTGRES_USER: "app",
        POSTGRES_PASSWORD: "p@ss word",
        POSTGRES_DB: "appdb",
      },
    },
    cache: { image: "docker.io/library/redis:7" },
    tool: { image: "adminer", labels: { "devwebui.ignore": "true" } },
  },
});

const row = (service: string, target: number, published: number) =>
  JSON.stringify({
    Service: service,
    State: "running",
    Publishers: [{ URL: "0.0.0.0", TargetPort: target, PublishedPort: published }],
  });

/** A fake docker CLI: `ps` answers from `running`, `up` marks every named service running. */
function fakeDocker(initiallyRunning: string[]) {
  const running = new Set(initiallyRunning);
  const calls: string[][] = [];
  const ports: Record<string, [number, number]> = { db: [5432, 55432], cache: [6379, 56379] };
  const run = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    if (args.includes("config")) return { code: 0, stdout: CONFIG, stderr: "" };
    if (args.includes("ps")) {
      const lines = [...running].map((s) => row(s, ...(ports[s] ?? ([80, 8080] as const))));
      return { code: 0, stdout: lines.join("\n"), stderr: "" };
    }
    if (args.includes("up")) {
      for (const s of args.slice(args.indexOf("-d") + 1)) running.add(s);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls };
}

const probe = async () => true;

test("prepareCompose: an already-running stack is not brought up again", async () => {
  const docker = fakeDocker(["db", "cache"]);
  const res = await prepareCompose({}, ".", { run: docker.run, probe });
  expect(res.ok).toBe(true);
  expect(docker.calls.some((a) => a.includes("up"))).toBe(false);
  if (res.ok) expect(res.started).toEqual([]);
});

test("prepareCompose: starts only the stopped, non-ignored services and reports them", async () => {
  const docker = fakeDocker(["cache"]);
  const res = await prepareCompose({}, ".", { run: docker.run, probe });
  const up = docker.calls.find((a) => a.includes("up"));
  expect(up).toEqual(["compose", "up", "-d", "db", "cache"]);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.started).toEqual(["db"]);
  expect(res.env.DATABASE_URL).toBe("postgres://app:p%40ss%20word@127.0.0.1:55432/appdb");
  expect(res.env.REDIS_URL).toBe("redis://127.0.0.1:56379");
  expect(res.sources).toEqual({ DATABASE_URL: "db", REDIS_URL: "cache" });
});

test("prepareCompose: a port that never opens fails the start instead of spawning", async () => {
  const docker = fakeDocker(["db"]);
  const spec = { services: ["db"], readinessTimeoutMs: 1 };
  const deps = { run: docker.run, probe: async () => false, pollMs: 1 };
  const res = await prepareCompose(spec, ".", deps);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("55432");
});

test("connectionEnv: ignored, stopped or unpublished services inject nothing", () => {
  const svc = (over: Partial<ComposeService>): ComposeService => ({
    name: "db",
    image: "postgres:16",
    environment: {},
    labels: {},
    running: true,
    ports: [{ host: "127.0.0.1", target: 5432, published: 5432 }],
    ...over,
  });
  expect(connectionEnv([svc({ labels: { "devwebui.ignore": "" } })]).env).toEqual({});
  expect(connectionEnv([svc({ running: false })]).env).toEqual({});
  expect(connectionEnv([svc({ ports: [] })]).env).toEqual({});
  expect(connectionEnv([svc({})]).env.DATABASE_URL).toBe(
    "postgres://postgres@127.0.0.1:5432/postgres",
  );
});

test("imageName and parseComposePs accept every shape Compose emits", () => {
  expect(imageName("ghcr.io/org/postgres:16@sha256:abc")).toBe("postgres");
  expect(imageName("localhost:5000/redis")).toBe("redis");
  const one = { Service: "db", State: "running" };
  expect(parseComposePs(JSON.stringify([one]))).toEqual([one]);
  expect(parseComposePs(`${JSON.stringify(one)}\n${JSON.stringify(one)}\n`)).toHaveLength(2);
  expect(parseComposePs("")).toEqual([]);
});
