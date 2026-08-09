// Shared filter + sort for a process list, so the card grid and the table render
// the exact same ordering off one set of preferences (held in the store). Pure +
// stateless — pass the current options in, get a new arranged array back.
import type { ProcessView, SortDir, SortKey, Status, StatusBucket } from "@/types";

/** Collapse the six raw statuses into the four buckets the filter exposes. */
export function statusBucket(s: Status): StatusBucket {
  if (s === "running") return "running";
  if (s === "crashed") return "crashed";
  if (s === "starting" || s === "stopping" || s === "waiting") return "busy";
  return "stopped";
}

/** Sort precedence for the "status" column: live first, problems next, idle last. */
const STATUS_RANK: Record<Status, number> = {
  running: 0,
  starting: 1,
  waiting: 1,
  stopping: 1,
  crashed: 2,
  stopped: 3,
};

function uptimeSecs(p: ProcessView, now: number): number {
  return p.status === "running" && p.startedAt ? Math.floor((now - p.startedAt) / 1000) : -1;
}

export interface ArrangeOptions {
  sortKey: SortKey;
  sortDir: SortDir;
  statusFilter: StatusBucket[];
  /** Shared clock, only needed for the "uptime" sort. */
  now: number;
  /** Case-insensitive process-name filter (the toolbar search box); blank matches everything. */
  search?: string;
}

export function arrangeProcesses(list: ProcessView[], opts: ArrangeOptions): ProcessView[] {
  const allowed = new Set(opts.statusFilter);
  const q = opts.search?.trim().toLowerCase();
  const filtered = list.filter(
    (p) => allowed.has(statusBucket(p.status)) && (!q || p.name.toLowerCase().includes(q)),
  );

  // Missing numeric values sort to the very bottom regardless of direction.
  const num = (v: number | null | undefined) => (v == null ? Number.NEGATIVE_INFINITY : v);
  const byName = (a: ProcessView, b: ProcessView) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

  const primary = (a: ProcessView, b: ProcessView): number => {
    switch (opts.sortKey) {
      case "name":
        return byName(a, b);
      case "status":
        return STATUS_RANK[a.status] - STATUS_RANK[b.status];
      case "port":
        return num(a.port) - num(b.port);
      case "cpu":
        return num(a.cpu) - num(b.cpu);
      case "memory":
        return num(a.memory) - num(b.memory);
      case "uptime":
        return uptimeSecs(a, opts.now) - uptimeSecs(b, opts.now);
      default:
        return 0;
    }
  };

  const dir = opts.sortDir === "asc" ? 1 : -1;
  // Starred processes float to the top regardless of sort key/direction; ties fall
  // through to the normal sort, then the name tie-break, so equal rows stay stable.
  return [...filtered].sort(
    (a, b) => Number(!!b.starred) - Number(!!a.starred) || primary(a, b) * dir || byName(a, b),
  );
}
