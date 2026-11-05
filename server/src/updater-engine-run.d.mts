// Types for updater-engine-run.mjs (the engine's command runner and its step helpers), so the TypeScript
// tests can import them. Every value export of the .mjs is declared here (scripts/checks/kit-lib-type-drift.mjs).

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunnerOptions {
  appRoot: string;
  run?: ((args: string[], opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }) => Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>) | null;
}

export interface Runner {
  runCommand(args: string[], timeoutMs: number, cwd?: string): Promise<RunResult>;
  git(args: string[], timeoutMs?: number): Promise<RunResult>;
  gitText(args: string[], timeoutMs?: number): Promise<string | null>;
}

export interface DueStep {
  cmd: string[];
  cwd: string;
  dir: string;
}

export const CHECK_TIMEOUT_MS: number;
export const APPLY_TIMEOUT_MS: number;
export const BUILD_TIMEOUT_MS: number;

export function createRunner(opts: RunnerOptions): Runner;
export function oneAtATime<T, R>(items: T[], step: (item: T) => Promise<R> | R): Promise<R[]>;
export function commandSummary(args: string[], result: RunResult, where?: string): string;
export function stepFailureMessage(args: string[], result: RunResult): string;
export function runStep(
  runCommand: Runner["runCommand"],
  args: string[],
  timeoutMs: number,
  output: string[],
  cwd: string,
  where?: string,
): Promise<void>;
export function runDueSteps(
  runCommand: Runner["runCommand"],
  due: DueStep[],
  output: string[],
): Promise<{ step: DueStep; result: RunResult } | null>;
