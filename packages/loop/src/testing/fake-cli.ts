import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliEngine } from "@ng/protocol";

/** The fake CLI agent script (fake-cli-agent.mjs; see its header for the scenario format). */
export const FAKE_CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "fake-cli-agent.mjs");

export type FakeCliAction =
  | { text: string }
  | { mcp: string; args?: unknown }
  | { native: string; input?: unknown; output?: string; kind?: string; path?: string }
  /** codex reports it as the session's running total (like the real CLI); `cached`: cache reads among `tokens`. */
  | { usage: { tokens?: number; costUsd?: number; cached?: number } }
  /** codex only: a raw item emitted as `item.completed` (e.g. a code-mode `custom_tool_call`). */
  | { item: Record<string, unknown> }
  | { sleep: number }
  | { fail: string }
  | { exit: number };

export interface FakeCliTurn {
  actions: FakeCliAction[];
  /** Claude can report a successful result while acknowledging an interrupt. */
  acknowledgeInterrupt?: boolean;
  omitQueuedTurnCount?: boolean;
}

export interface FakeCliLogEntry {
  engine: string;
  pid: number;
  type: string;
  [key: string]: unknown;
}

export interface FakeCli {
  engine: CliEngine;
  /** Executable to hand the CLI loop as `bin`. */
  bin: string;
  /** Environment for the CLI loop (`env`): the kernel's plus the scenario pointer. */
  env: Record<string, string | undefined>;
  dir: string;
  /** Replace the scripted turns (the turn counter is kept). */
  setTurns(turns: FakeCliTurn[]): void;
  /** Everything the fake observed, in order. */
  log(): FakeCliLogEntry[];
  /** Launch argv of each process. */
  launches(): string[][];
  /** User inputs the fake received, in order. */
  prompts(): string[];
}

/** Installs `<dir>/<engine>` (a shell wrapper around fake-cli-agent.mjs) with its own session store and log. */
export function installFakeCli(dir: string, engine: CliEngine, turns: FakeCliTurn[] = []): FakeCli {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, engine);
  const scenarioFile = join(dir, `${engine}-scenario.json`);
  const logFile = join(dir, `${engine}-log.jsonl`);
  const store = join(dir, `${engine}-store`);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI_PATH}" ${engine} "$@"\n`);
  chmodSync(bin, 0o755);
  const setTurns = (t: FakeCliTurn[]) => writeFileSync(scenarioFile, JSON.stringify({ store, log: logFile, turns: t }));
  setTurns(turns);
  const log = (): FakeCliLogEntry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakeCliLogEntry)
      : [];
  return {
    engine,
    bin,
    env: { ...process.env, FAKECLI_SCENARIO: scenarioFile },
    dir,
    setTurns,
    log,
    launches: () => log().filter((e) => e.type === "argv").map((e) => e["argv"] as string[]),
    prompts: () => log().filter((e) => e.type === "prompt").map((e) => e["text"] as string),
  };
}
