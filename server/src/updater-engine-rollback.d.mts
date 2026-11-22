import type { DueStep, Runner } from "./updater-engine-run.mjs";

export function createRollback(options: {
  serviceName: string;
  runCommand: Runner["runCommand"];
  gitText: Runner["gitText"];
}): {
  rollbackAfterFailedUpdate(
    err: unknown,
    before: { branch: string | null; currentCommit: string | null; remoteCommit: string | null },
    output: string[],
    landed?: Array<{ path: string; deleted?: boolean }> | null,
    due?: DueStep[],
  ): Promise<never>;
};
