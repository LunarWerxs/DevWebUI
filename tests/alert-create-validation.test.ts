// Regression: alert-rule numeric and boolean fields are validated as real JSON types. Number()
// coercion used to let null, false, "" and [] pass as a non-negative threshold/forMs, and a
// non-boolean `enabled` was silently dropped so the rule was created enabled.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { expect, test } from "bun:test";
import { createApp } from "../server/src/http";
import { Manager } from "../server/src/manager";
import { ROUTES } from "../shared/routes";
import type { LoadedProject, ProcessDef } from "../server/src/types";

const JSON_HEADERS = { "content-type": "application/json" };

function setup() {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const processDef: ProcessDef = {
    id: "alert-validate.web",
    name: "web",
    command: "echo hi",
    cwd: import.meta.dir,
    autostart: false,
    projectId: "alert-validate",
    projectName: "alert-validate",
  };
  const project: LoadedProject = {
    id: "alert-validate",
    name: "alert-validate",
    path: `${import.meta.dir}\\alert-validate.devwebui`,
    dir: import.meta.dir,
    processes: [processDef],
  };
  manager.addProject(project, { autostart: false });
  return { manager, app: createApp(manager, {}) };
}

test("alert rules: create and update reject non-number threshold/forMs values", async () => {
  const { manager, app } = setup();
  try {
    const before = manager.listAlertRules().length;
    for (const bad of [null, false, "", [], "80"]) {
      const create = await app.request(ROUTES.alertRules, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ processId: "alert-validate.web", metric: "cpu", threshold: bad }),
      });
      expect(create.status).toBe(400);
      const forMs = await app.request(ROUTES.alertRules, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          processId: "alert-validate.web",
          metric: "cpu",
          threshold: 80,
          forMs: bad,
        }),
      });
      expect(forMs.status).toBe(400);
    }
    expect(manager.listAlertRules()).toHaveLength(before);

    const created = await app.request(ROUTES.alertRules, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ processId: "alert-validate.web", metric: "cpu", threshold: 80 }),
    });
    expect(created.status).toBe(200);
    const rule = (await created.json()) as { id: string };
    const update = await app.request(ROUTES.alertRule.build(rule.id), {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ threshold: null }),
    });
    expect(update.status).toBe(400);
    await app.request(ROUTES.alertRule.build(rule.id), { method: "DELETE" });
  } finally {
    manager.dispose();
  }
});

test("alert rules: a non-boolean enabled is rejected with 400 and no rule is created", async () => {
  const { manager, app } = setup();
  try {
    const before = manager.listAlertRules().length; // the rule store is shared across runs
    const res = await app.request(ROUTES.alertRules, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        processId: "alert-validate.web",
        metric: "cpu",
        threshold: 80,
        enabled: "false",
      }),
    });
    expect(res.status).toBe(400);
    expect(manager.listAlertRules()).toHaveLength(before);
  } finally {
    manager.dispose();
  }
});
