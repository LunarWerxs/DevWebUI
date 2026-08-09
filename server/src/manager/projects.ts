import type { LoadedProject } from "../types";
import { deleteLogs } from "../log-vault";
import { clearEnabledOverrides, clearProjectOverride } from "../state";
import { ManagerWithLifecycle } from "./lifecycle";

/**
 * Project registration/reload/removal — the "write" half of project
 * management (the read-only `listProjects`/`getProjectPath` live in
 * `ManagerBase` since they're also needed there for `emitProjects`).
 */
export class ManagerWithProjects extends ManagerWithLifecycle {
  // ---- projects ---------------------------------------------------------
  /**
   * Register (or hard-reload) a project. Use reconcileProject for in-place edits.
   * `opts.autostart` (default true) gates the launch-time auto-start: the boot loop
   * passes the `autoStartOnLaunch` setting so a fresh daemon doesn't stampede every
   * server, while runtime GUI adds keep auto-starting per their toggles.
   */
  addProject(p: LoadedProject, opts?: { autostart?: boolean }): void {
    const prev = this.projects.get(p.id);
    if (prev) {
      // Hard reload: forget toggles for processes that no longer exist in the file
      // (a renamed/removed id would otherwise leak forever in state.json).
      const incoming = new Set(p.processes.map((x) => x.id));
      clearEnabledOverrides(prev.processIds.filter((id) => !incoming.has(id)));
      this.purgeProject(p.id);
    }
    this.projects.set(p.id, {
      id: p.id,
      name: p.name,
      color: p.color,
      path: p.path,
      processIds: p.processes.map((x) => x.id),
    });
    for (const def of p.processes) this.entries.set(def.id, this.newEntry(def));
    if (opts?.autostart ?? true)
      this.startMany(p.processes.filter((def) => this.willAutostart(def)).map((def) => def.id));
    this.emitProjects();
  }

  /**
   * Apply a re-read of a project's file, preserving the running state of unchanged processes.
   *
   * `opts.fromWatch` marks a reload triggered by the file changing ON DISK rather than by a
   * user action in the GUI/CLI/MCP. That distinction is a security boundary: a `git pull`,
   * a branch switch, or a teammate's commit can change a `.devwebui` with no code execution
   * involved, and applying it blindly would relaunch a running server on an attacker-supplied
   * command — or start a brand-new one — within one debounce window. So a watch-driven reload
   * REGISTERS the new definition but does not act on it: changed processes keep running as
   * they were and are flagged `configChanged` for an explicit restart, and newly-appeared
   * processes stay stopped regardless of `autostart`. GUI-driven edits (opts absent) apply
   * immediately, exactly as before — the user is right there and asked for it.
   */
  reconcileProject(lp: LoadedProject, opts?: { fromWatch?: boolean }): void {
    const fromWatch = opts?.fromWatch === true;
    const existing = this.projects.get(lp.id);
    if (!existing) {
      this.addProject(lp, { autostart: !fromWatch });
      return;
    }

    const incoming = new Map(lp.processes.map((p) => [p.id, p]));
    for (const pid of [...existing.processIds]) {
      if (!incoming.has(pid)) {
        const e = this.entries.get(pid);
        if (e) this.discardEntry(e);
        this.entries.delete(pid);
        this.errors.clear(pid);
        clearEnabledOverrides([pid]); // process removed from the file — forget its toggle
      }
    }

    const newAutostartIds: string[] = [];
    for (const def of lp.processes) {
      const e = this.entries.get(def.id);
      if (!e) {
        this.entries.set(def.id, this.newEntry(def));
        if (this.willAutostart(def) && !fromWatch) newAutostartIds.push(def.id);
      } else {
        const execChanged =
          e.def.command !== def.command ||
          e.def.cwd !== def.cwd ||
          e.def.runtime !== def.runtime ||
          JSON.stringify(e.def.env ?? null) !== JSON.stringify(def.env ?? null);
        e.def = def;
        if (execChanged && e.child) {
          if (fromWatch) {
            // Registered, not applied — the running child keeps the definition it started
            // with until the user restarts it. `configChanged` drives the GUI's badge.
            e.configChanged = true;
            this.addLog(
              e,
              "stderr",
              "[devwebui] this process's .devwebui entry changed on disk; restart it to apply the new command.",
            );
            this.emitStatus(e);
          } else {
            void this.restart(def.id);
          }
        } else this.emitStatus(e);
      }
    }
    this.startMany(newAutostartIds);

    existing.name = lp.name;
    existing.color = lp.color;
    existing.processIds = lp.processes.map((p) => p.id);
    this.emitProjects();
  }

  async removeProject(id: string): Promise<void> {
    const proj = this.projects.get(id);
    if (!proj) return;
    await Promise.all(proj.processIds.map((pid) => this.stop(pid)));
    for (const pid of proj.processIds) {
      this.errors.clear(pid);
      deleteLogs(pid); // no reader can ever reach these again — don't leave them on disk
    }
    clearEnabledOverrides(proj.processIds); // explicit removal — drop its toggles
    clearProjectOverride(id);
    this.purgeProject(id);
    this.emitProjects();
  }

  private purgeProject(id: string): void {
    const proj = this.projects.get(id);
    if (!proj) return;
    for (const pid of proj.processIds) {
      const e = this.entries.get(pid);
      if (e) this.discardEntry(e);
      this.entries.delete(pid);
    }
    this.projects.delete(id);
  }

  startProject(id: string): void {
    const p = this.projects.get(id);
    if (p) this.startMany(p.processIds);
  }

  /** Ids of every process with a live child — the snapshot the auto-update relaunch restores. */
  runningIds(): string[] {
    return [...this.entries.values()].filter((e) => e.child).map((e) => e.def.id);
  }

  /** Start an explicit list of ids through the ordinary staggered, dependency-ordered queue. */
  startProcesses(ids: string[]): void {
    this.startMany(ids.filter((id) => this.entries.has(id)));
  }

  async stopProject(id: string): Promise<void> {
    const p = this.projects.get(id);
    if (p) await Promise.all(p.processIds.map((pid) => this.stop(pid)));
  }
}
