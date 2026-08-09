import type { Context, Hono } from "hono";
import type { Manager } from "../manager";
import {
  addProcessToFile,
  readDevWebUIFile,
  registryRemove,
  removeProcessFromFile,
  setProcessStarred,
  updateProcessInFile,
  updateProjectMeta,
} from "../projects";
import type { ProjectView } from "../types";
import { ROUTES } from "../../../shared/routes";
import { createProcessShortcut, createProjectShortcut } from "../shortcuts";
import { fail, guard, readBody } from "./core";

/** Register project-process-editing routes and live-process-instance routes. */
export function registerProcessRoutes(app: Hono, manager: Manager) {
  /** Re-read a project's file and apply it, preserving unchanged running processes. */
  function reloadProject(id: string): ProjectView | null {
    const filePath = manager.getProjectPath(id);
    if (!filePath) return null;
    manager.reconcileProject(readDevWebUIFile(filePath));
    return manager.listProjects().find((p) => p.id === id) ?? null;
  }

  /**
   * Resolve a project's .devwebui path, or a 404 `{ error: "unknown project" }` to
   * return. Call sites must `return` the {@link Response} when one comes back:
   * `if (p instanceof Response) return p;`.
   */
  function requireProjectPath(c: Context, id: string): string | Response {
    const filePath = manager.getProjectPath(id);
    return filePath ?? fail(c, "unknown project", 404);
  }

  // ---- project meta editing (rename + recolor — rewrites the file, then reconciles) ----
  app.put(ROUTES.projectUpdate.pattern, async (c) => {
    const id = c.req.param("id");
    const filePath = requireProjectPath(c, id);
    if (filePath instanceof Response) return filePath;
    const body = await readBody(c);
    return guard(c, () => {
      updateProjectMeta(filePath, {
        name: typeof body?.name === "string" ? body.name : undefined,
        color: typeof body?.color === "string" ? body.color : undefined,
      });
      return c.json({ ok: true, project: reloadProject(id) });
    });
  });

  // ---- process editing (rewrites the .devwebui file, then reconciles) ----
  app.post(ROUTES.projectProcesses.pattern, async (c) => {
    const id = c.req.param("id");
    const filePath = requireProjectPath(c, id);
    if (filePath instanceof Response) return filePath;
    const body = await readBody(c);
    return guard(c, () => {
      addProcessToFile(filePath, body);
      return c.json({ ok: true, project: reloadProject(id) });
    });
  });

  app.put(ROUTES.projectProcess.pattern, async (c) => {
    const { id, localId } = c.req.param();
    const filePath = requireProjectPath(c, id);
    if (filePath instanceof Response) return filePath;
    const body = await readBody(c);
    return guard(c, () => {
      updateProcessInFile(filePath, localId, body);
      return c.json({ ok: true, project: reloadProject(id) });
    });
  });

  app.delete(ROUTES.projectProcess.pattern, async (c) => {
    const { id, localId } = c.req.param();
    const filePath = requireProjectPath(c, id);
    if (filePath instanceof Response) return filePath;
    return guard(c, () => {
      removeProcessFromFile(filePath, localId);
      return c.json({ ok: true, project: reloadProject(id) });
    });
  });

  app.post(ROUTES.projectProcessStar.pattern, async (c) => {
    const { id, localId } = c.req.param();
    const filePath = requireProjectPath(c, id);
    if (filePath instanceof Response) return filePath;
    const body = await readBody(c);
    return guard(c, () => {
      setProcessStarred(filePath, localId, !!body?.starred);
      return c.json({ ok: true, project: reloadProject(id) });
    });
  });

  // Desktop shortcut for a whole codebase. Registered BEFORE projectAction: Hono
  // matches in registration order, and `/:id/:action` would otherwise claim
  // `/:id/shortcut` and reject it as an unknown action.
  app.post(ROUTES.projectShortcut.pattern, async (c) => {
    const id = c.req.param("id");
    const proj = manager.listProjects().find((p) => p.id === id);
    if (!proj) return fail(c, "unknown project", 404);
    return c.json(await createProjectShortcut({ devwebuiPath: proj.path, projectName: proj.name }));
  });

  app.post(ROUTES.projectAction.pattern, async (c) => {
    const { id, action } = c.req.param();
    const proj = manager.listProjects().find((p) => p.id === id);
    if (!proj) return fail(c, "unknown project", 404);
    // guard(): an unexpected manager throw becomes the same `{ error }` shape every other
    // route returns, instead of Hono's bare text/plain 500 — the CLI and MCP surface the
    // message verbatim, so a raw 500 loses the only diagnostic the caller ever sees.
    return guard(c, async () => {
      if (action === "start") manager.startProject(id);
      else if (action === "stop") await manager.stopProject(id);
      else if (action === "enable") manager.setProjectEnabled(id, true);
      else if (action === "disable") manager.setProjectEnabled(id, false);
      else if (action === "remove") {
        await manager.removeProject(id);
        registryRemove(proj.path);
      } else return fail(c, "unknown action");
      return c.json({ ok: true });
    });
  });

  // ---- processes ----
  app.get(ROUTES.processes, (c) => c.json(manager.list()));
  app.get(ROUTES.processLogs.pattern, (c) =>
    c.json({ id: c.req.param("id"), lines: manager.getLogs(c.req.param("id")) }),
  );
  // Time-Travel Log Vault: tail the on-disk rotating log file (survives daemon
  // restarts and the in-memory 500-line cap). No search/indexing — just a tail.
  app.get(ROUTES.processLogFile.pattern, (c) => {
    const id = c.req.param("id");
    if (!manager.view(id)) return fail(c, "unknown process", 404);
    const linesParam = Number(c.req.query("lines"));
    const lines = Number.isFinite(linesParam) && linesParam > 0 ? Math.floor(linesParam) : 200;
    return c.json({ id, lines: manager.getLogFileTail(id, lines) });
  });
  app.post(ROUTES.startAll, (c) => {
    manager.startAll();
    return c.json({ ok: true });
  });
  app.post(ROUTES.stopAll, async (c) => {
    await manager.stopAll();
    return c.json({ ok: true });
  });
  app.post(ROUTES.processFreePort.pattern, async (c) => {
    const id = c.req.param("id");
    const v = manager.view(id);
    if (!v) return fail(c, "unknown process", 404);
    if (!v.port) return fail(c, "process has no declared port");
    // Stop a managed holder cleanly; require explicit confirm to kill external owners.
    const body = await readBody(c);
    return c.json(await manager.freeProcessPort(id, { confirm: !!body.confirm }));
  });

  // Incident Autopilot: composite root-cause guess + remediation suggestion (never auto-executed).
  app.get(ROUTES.processDiagnose.pattern, async (c) => {
    const id = c.req.param("id");
    const diagnosis = await manager.diagnoseProcess(id);
    if (!diagnosis) return fail(c, "unknown process", 404);
    return c.json(diagnosis);
  });

  // Desktop shortcut for ONE process. Registered BEFORE processAction for the same
  // `/:id/:action` shadowing reason as free-port/diagnose above. Returns the shortcut
  // module's result verbatim, including its non-throwing `{ ok: false, reason }`
  // shapes (a Mac/Linux caller, or a PowerShell that refused) — the GUI reports those
  // rather than treating them as a request failure.
  app.post(ROUTES.processShortcut.pattern, async (c) => {
    const id = c.req.param("id");
    const v = manager.view(id);
    if (!v) return fail(c, "unknown process", 404);
    const filePath = manager.getProjectPath(v.projectId);
    if (!filePath) return fail(c, "unknown project", 404);
    return c.json(
      await createProcessShortcut({
        devwebuiPath: filePath,
        localId: v.localId,
        processName: v.name,
        projectName: v.projectName,
      }),
    );
  });

  app.post(ROUTES.processAction.pattern, async (c) => {
    const { id, action } = c.req.param();
    if (!manager.view(id)) return fail(c, "unknown process", 404);
    // A linked group acts as one unit: startWithLinks also brings up the linked
    // group + project companions; stopWithLinks brings the linked group down.
    // `coStarted`/`coStopped` list the OTHER processes the action set in motion,
    // so the GUI (and MCP callers) can surface the ripple.
    // guard(): see the note on projectAction above — same reason, same shape.
    return guard(c, async () => {
      let coStarted: string[] | undefined;
      let coStopped: string[] | undefined;
      if (action === "start") {
        coStarted = manager.startWithLinks(id).coStarted;
      } else if (action === "stop") coStopped = await manager.stopWithLinks(id);
      else if (action === "restart") await manager.restart(id);
      else if (action === "enable") manager.setProcessEnabled(id, true);
      else if (action === "disable") manager.setProcessEnabled(id, false);
      else return fail(c, "unknown action");
      return c.json({ ok: true, process: manager.view(id), coStarted, coStopped });
    });
  });
}
