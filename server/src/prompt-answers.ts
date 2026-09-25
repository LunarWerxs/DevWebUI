// Prompt answers: expect/send rules that reply to a dev server's interactive
// prompts on its stdin. WHY: an unattended process that stops at "Port 3000 is
// in use, use another? (Y/n)" or npx's "Ok to proceed? (y)" otherwise hangs
// forever with nobody at a terminal to type the answer.
//
// The idea (an ordered rule list watched against session output) follows the
// login-script processor in Eugeny/tabby (MIT); this is a fresh implementation.
//
// Semantics, per spawn of a process:
//   - Rules run in file order. A rule fires at most once, then is consumed.
//   - A rule with no `expect` fires as soon as the process spawns (it and any
//     other leading expect-less rules), before any output is seen.
//   - On output, the pending rules are walked in order: a match fires and is
//     consumed; an `optional` rule that does not match is passed over (it stays
//     armed); the walk stops at the first required rule that has not matched.
//   - After the user's rules, a small built-in table of common prompts applies
//     (all optional) unless the process sets `autoAnswer: false`.
// Pure and I/O-free: the caller feeds output text in and writes what comes back.
import { stripAnsi } from "./errors";

export interface AnswerRule {
  /** Text (or a regex source when `isRegex`) to wait for in the output. Omit to send on spawn. */
  expect?: string;
  /** What to type. Escapes \n \r \t \xHH \uHHHH \\ are decoded; a newline is added unless it ends in one. */
  send: string;
  isRegex?: boolean;
  /** An optional rule that has not matched does not hold back the rules after it. */
  optional?: boolean;
}

/**
 * The built-in answers: only prompts that block a configured dev command from
 * continuing, answered the way a developer at the terminal usually would. Kept
 * deliberately small (same stance as diagnose.ts's known-signature table).
 */
export const BUILTIN_ANSWERS: readonly AnswerRule[] = [
  // CRA / Angular / Nuxt style "the port is taken, use another one?" questions.
  {
    expect: String.raw`(?:another|a different) port(?: instead)?\?[^\n]*\((?:Y/n|y/N|y/n)\)`,
    send: "y",
    isRegex: true,
    optional: true,
  },
  // npx / npm exec asking to install the package the command itself names.
  { expect: "Ok to proceed? (y)", send: "y", optional: true },
  // First-run usage-data questions (Angular CLI analytics and similar): decline.
  {
    expect: String.raw`(?:share|send)[^\n]*(?:usage data|analytics|telemetry)[^\n]*\?[^\n]*\((?:y/N|Y/n|y/n)\)`,
    send: "n",
    isRegex: true,
    optional: true,
  },
];

const ESCAPE_RE = /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|([nrt\\]))/g;

/** Decode the escapes a JSON author cannot type literally into a control character. */
export function decodeEscapes(text: string): string {
  return text.replace(ESCAPE_RE, (_m, hex, uni, ch) => {
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
    if (uni) return String.fromCharCode(Number.parseInt(uni, 16));
    return ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : "\\";
  });
}

/** The bytes a rule types: its decoded `send` plus a newline unless it already ends in one. */
export function answerText(rule: AnswerRule): string {
  const decoded = decodeEscapes(rule.send);
  return /[\r\n]$/.test(decoded) ? decoded : `${decoded}\n`;
}

// Output kept for matching a prompt split across chunks; a prompt is one short line or two.
const MAX_BUFFER = 4096;

interface Armed {
  rule: AnswerRule;
  re: RegExp | null;
}

function arm(rule: AnswerRule): Armed {
  if (!rule.expect || !rule.isRegex) return { rule, re: null };
  try {
    return { rule, re: new RegExp(rule.expect, "i") };
  } catch {
    // An invalid pattern can never match; fall back to a literal search so the rule
    // still means something rather than throwing inside the spawn path.
    return { rule: { ...rule, isRegex: false }, re: null };
  }
}

export class PromptAnswerer {
  private pending: Armed[];
  // A separate chain so a user's required rule that never matches cannot hold them back.
  private builtins: Armed[];
  private buffer = "";

  constructor(rules: readonly AnswerRule[] | undefined, builtins = true) {
    this.pending = (rules ?? []).map(arm);
    this.builtins = builtins ? BUILTIN_ANSWERS.map(arm) : [];
  }

  /** The rules still waiting to fire (for tests and diagnostics). */
  get remaining(): number {
    return this.pending.length + this.builtins.length;
  }

  /** Answers to type the moment the process spawns: the leading rules with no `expect`. */
  start(): AnswerRule[] {
    const fired: AnswerRule[] = [];
    while (this.pending.length && !this.pending[0].rule.expect)
      fired.push((this.pending.shift() as Armed).rule);
    return fired;
  }

  /** Feed one chunk of process output; returns the rules that fired, in order. */
  feed(chunk: string): AnswerRule[] {
    if (!this.remaining) return [];
    this.buffer = (this.buffer + stripAnsi(chunk)).slice(-MAX_BUFFER);
    const fired = this.walk(this.pending);
    // A prompt the user's rules already answered has cleared the buffer, so the
    // built-ins only ever see output nobody has replied to yet.
    fired.push(...this.walk(this.builtins));
    return fired;
  }

  /** Walk one ordered chain against the buffer, consuming the rules that fire. */
  private walk(chain: Armed[]): AnswerRule[] {
    const fired: AnswerRule[] = [];
    for (let i = 0; i < chain.length; ) {
      const armed = chain[i];
      const { expect, optional } = armed.rule;
      const hit = !expect || (armed.re ? armed.re.test(this.buffer) : this.buffer.includes(expect));
      if (hit) {
        fired.push(armed.rule);
        chain.splice(i, 1);
        // The prompt that matched is answered: never let it satisfy a later rule too.
        this.buffer = "";
        continue;
      }
      if (!optional) break;
      i++;
    }
    return fired;
  }
}
