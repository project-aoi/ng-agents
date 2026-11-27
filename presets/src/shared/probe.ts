import {
  CELL_STATUS_KEY,
  PAYLOAD,
  type CellResultPayload,
  type CodeProcessor,
  type ProcessorSpec,
  type RunPorts,
  type TimerFiredPayload,
} from "@ng/protocol";
import { KEYS, PROCESSORS, type PresetsConfig } from "./config";
import { errorText } from "./inputs";
import { clip, formatWhen, statusLine } from "./records";

// A checker dispatched with a check command (BUG-005): zero tokens while the answer is "not yet". Every wake-up — its
// task, then its own timer, or a message routed to it — runs the command in the cell's directory (the project's). The
// condition holding, the deadline passing, or the command failing to run at all twice in a row ends it with one result
// for the project; a one_shot cell is then closed by the kernel, timers included. "Not yet" ends the Run as waiting,
// which keeps a one_shot cell open.
//
// cannot say "every 45 seconds". Whatever woke a check, the pending reminder is dropped and the next one set afresh,
// so there is never more than one.
//
// What it does not do: wake a model to judge an ambiguous answer. Anything it cannot settle by exit status — the
// command will not run, the deadline passed — goes to the project as a failed result, and the project decides.

export type ProbeUntil = "exit_zero" | "output_changes";

/** `processor.args` of a probe checker, as dispatch writes them. */
export interface ProbeArgs {
  command: string;
  everySec: number;
  until: ProbeUntil;
  /** Epoch ms; absent = no deadline. */
  deadlineAt?: number;
  timeoutMs: number;
  /** Monotonic timestamp bumped by update_check to force baseline/backoff reset even when command text is unchanged or legacy state lacked `command`. */
  updatedAt?: number;
}

/** KEYS.probe: what the probe keeps between wake-ups. */
export interface ProbeState {
  v: 1;
  checks: number;
  /** Consecutive checks in which the command could not run at all. */
  cannotRun: number;
  /** Command string this state belongs to; changing the command in place resets baselines and backoff. */
  command?: string;
  /** Last ProbeArgs.updatedAt applied to this state. */
  targetUpdatedAt?: number;
  /** When polling started for the current target command. */
  startedAt?: number;
  /** Last timestamp when output/state changed (used for stagnant long-poll backoff). */
  backoffResetAt?: number;
  /** Count of consecutive checks with identical non-terminal output (updated in place without evidence bloat). */
  unchangedChecks?: number;
  /** True while suspended because the parent project is paused or waiting on a blocking human decision card. */
  suspended?: boolean;
  /** Trimmed output of the last check that ran — the baseline for "output_changes". */
  last?: string;
  lastExit?: number;
  lastAt?: number;
  /** Re-publish the terminal report if another claim drains before the checker closes. */
  result?: CellResultPayload;
}

export const PROBE = {
  everySec: 300,
  minEverySec: 30,
  /** Long-poll backoff thresholds and caps (M5). */
  backoffAfter1Ms: 30 * 60_000,
  backoffSec1: 300,
  backoffAfter2Ms: 60 * 60_000,
  backoffSec2: 600,
  /** Safety-net check interval while suspended for a blocked/paused parent (also woken immediately on card resolution). */
  suspendedEverySec: 1_800,
  /** A check is one quick command; it never gets longer than its interval. */
  timeoutMs: 60_000,
  timers: "probe",
} as const;

export function probeProcessor(args: ProbeArgs): ProcessorSpec {
  return { kind: "code", entry: PROCESSORS.checkProbe, args: { ...args } };
}

type Check = { ran: true; exitCode: number; output: string } | { ran: false; why: string; output: string };

/**
 * The shell's own "not found" line (bash, also localized; sh/dash): in a pipeline (`gh … | grep -q X`) the last
 * command's status hides the 127, and without this a missing CLI would read as "not yet" forever.
 */
const NOT_FOUND = /: command not found\s*$|未找到命令\s*$|^sh: \d+: [^\n]+: not found\s*$/m;

async function runCheck(ports: RunPorts, a: ProbeArgs, signal: AbortSignal): Promise<Check> {
  let res;
  try {
    res = await ports.workspace.exec("bash", { command: a.command, timeoutMs: a.timeoutMs }, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    return { ran: false, why: `没能启动：${clip(errorText(err), 200)}`, output: "" };
  }
  const exitCode = res.exitCode ?? 0;
  const output = res.output.trim();
  if (exitCode === 124) return { ran: false, why: `超时（${Math.round(a.timeoutMs / 1000)} 秒没有结束）`, output };
  if (exitCode === 127 || (exitCode !== 0 && NOT_FOUND.test(output))) return { ran: false, why: `exit ${exitCode}：命令不存在`, output };
  if (exitCode === 126) return { ran: false, why: "exit 126：命令无法执行", output };
  return { ran: true, exitCode, output };
}

function parseArgs(args: Record<string, unknown>): ProbeArgs | string {
  const { command, everySec, until, deadlineAt, timeoutMs, updatedAt } = args;
  if (typeof command !== "string" || !command.trim()) return "没有检查命令";
  if (typeof everySec !== "number" || !(everySec >= PROBE.minEverySec)) return `检查间隔无效（${String(everySec)}）`;
  if (until !== "exit_zero" && until !== "output_changes") return `判定方式无效（${String(until)}）`;
  return {
    command,
    everySec,
    until,
    ...(typeof deadlineAt === "number" ? { deadlineAt } : {}),
    timeoutMs: typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : Math.min(PROBE.timeoutMs, everySec * 1000),
    ...(typeof updatedAt === "number" ? { updatedAt } : {}),
  };
}

export function createCheckProbe(cfg: PresetsConfig): CodeProcessor {
  return {
    name: PROCESSORS.checkProbe,
    description: "Checker with a check command: runs it on every wake-up, reports to its project only when the condition holds, the deadline passed or the command cannot run. Zero tokens.",
    async run({ ports, args, signal, clock, snapshot }) {
      const self = ports.self.cellId;
      const prev = (await ports.context.readState<ProbeState>(self, KEYS.probe)) ?? { v: 1, checks: 0, cannotRun: 0 };
      // Already reported (a message arrived before the close): the stored result still stands.
      async function deliver(result: CellResultPayload): Promise<"completed"> {
        await ports.cancelScheduled({ cellId: self, cancelGroup: PROBE.timers });
        await ports.emitToParent(PAYLOAD.cellResult, result);
        return "completed";
      }
      if (prev.result) return deliver(prev.result);

      const report = async (status: CellResultPayload["status"], summary: string, st: ProbeState, data: Record<string, unknown>, line: string): Promise<"completed"> => {
        const now = clock.now();
        // A leaf's result is stored as the candidate the kernel delivers when this Run settles — exactly once.
        const result: CellResultPayload = { childCellId: self, status, summary, data: { check: data } };
        await ports.context.commit(self, { statePatches: { [KEYS.probe]: { ...st, result } satisfies ProbeState, [CELL_STATUS_KEY]: statusLine(line, now) } });
        return deliver(result);
      };

      const a = parseArgs(args);
      if (typeof a === "string") return report("failed", `监听没法开始：${a}。`, prev, { error: a }, `没法开始：${a}`);

      const nowBefore = clock.now();
      // M5: If the parent updated this checker via update_check (even with the same command or on legacy state
      // without `prev.command`) or changed the command, reset baseline counters and backoff cleanly.
      const targetUpdated =
        (a.updatedAt !== undefined && a.updatedAt !== prev.targetUpdatedAt) ||
        (prev.command !== undefined && prev.command !== a.command);
      const base: ProbeState = targetUpdated
        ? {
            v: 1,
            checks: 0,
            cannotRun: 0,
            command: a.command,
            ...(a.updatedAt !== undefined ? { targetUpdatedAt: a.updatedAt } : {}),
            startedAt: nowBefore,
            backoffResetAt: nowBefore,
            unchangedChecks: 0,
            suspended: false,
          }
        : prev;

      // M5: Auto-suspend polling while parent project is paused or blocked on a pending human decision card (unless deadline reached).
      if (ports.parentBlockedOnHuman?.() && (a.deadlineAt === undefined || nowBefore < a.deadlineAt)) {
        const next = Math.min(nowBefore + PROBE.suspendedEverySec * 1000, a.deadlineAt ?? Number.POSITIVE_INFINITY);
        await ports.cancelScheduled({ cellId: self, cancelGroup: PROBE.timers });
        await ports.scheduleSelf(
          { id: `${self}:probe:${snapshot.runId}`, type: PAYLOAD.timerFired, payload: { label: "等待父项目恢复后再检查", data: { suspended: true } } satisfies TimerFiredPayload },
          { deliverAt: next, cancelGroup: PROBE.timers },
        );
        const st: ProbeState = {
          ...base,
          v: 1,
          command: a.command,
          ...(a.updatedAt !== undefined ? { targetUpdatedAt: a.updatedAt } : base.targetUpdatedAt !== undefined ? { targetUpdatedAt: base.targetUpdatedAt } : {}),
          startedAt: base.startedAt ?? nowBefore,
          backoffResetAt: base.backoffResetAt ?? nowBefore,
          suspended: true,
          lastAt: nowBefore,
        };
        await ports.context.commit(self, {
          statePatches: { [KEYS.probe]: st, [CELL_STATUS_KEY]: statusLine(`父项目等待主人确认中，已暂停轮询 · 已检查 ${st.checks} 次`, nowBefore) },
        });
        return "yielded_waiting";
      }

      const check = await runCheck(ports, a, signal);
      if (signal.aborted) return "cancelled";
      const now = clock.now();
      const when = formatWhen(now, cfg.timeZone);
      const n = base.checks + 1;
      const label = ports.self.spec.title ? `「${ports.self.spec.title}」` : "检查项";
      const facts = { command: a.command, until: a.until, checks: n, at: now, output: clip(check.output, 4_000) };

      const sameOutput =
        check.ran &&
        base.checks > 0 &&
        base.cannotRun === 0 &&
        base.lastExit === check.exitCode &&
        base.last === check.output;
      const willHold = check.ran && a.until === "exit_zero" && check.exitCode === 0;
      const willChange = check.ran && a.until === "output_changes" && base.last !== undefined && check.output !== base.last;
      const willFailCannotRun = !check.ran && base.cannotRun + 1 >= 2;
      const willDeadline = a.deadlineAt !== undefined && now >= a.deadlineAt;
      const isTerminal = willHold || willChange || willFailCannotRun || willDeadline;

      // M5: Write evidence only on check #1, changed output/status, command failure, or terminal outcome.
      // Identical non-terminal polls update ProbeState counters in place without spamming evidence.
      if (n === 1 || !sameOutput || !check.ran || isTerminal) {
        await ports.context.appendEvidence(self, {
          kind: "system_note",
          runId: snapshot.runId,
          at: now,
          text: `[check #${n} · ${check.ran ? `exit ${check.exitCode}` : check.why}]${check.output ? `\n${clip(check.output, 500)}` : ""}`,
        });
      }

      const startedAt = base.startedAt ?? now;
      const backoffResetAt = n === 1 || !sameOutput || base.suspended ? now : (base.backoffResetAt ?? startedAt);
      const unchangedChecks = sameOutput ? (base.unchangedChecks ?? 0) + 1 : 0;

      let st: ProbeState;
      if (check.ran) {
        const changed = base.last !== undefined && check.output !== base.last;
        st = {
          v: 1,
          checks: n,
          cannotRun: 0,
          command: a.command,
          ...(a.updatedAt !== undefined ? { targetUpdatedAt: a.updatedAt } : base.targetUpdatedAt !== undefined ? { targetUpdatedAt: base.targetUpdatedAt } : {}),
          startedAt,
          backoffResetAt,
          unchangedChecks,
          suspended: false,
          last: check.output,
          lastExit: check.exitCode,
          lastAt: now,
        };
        if (a.until === "exit_zero" && check.exitCode === 0) {
          const out = check.output ? `输出：${clip(check.output, 800)}` : "没有输出。";
          return report("completed", `条件已满足：${label}在 ${when} 返回 0（第 ${n} 次检查）。${out}`, st, { ...facts, exitCode: 0, outcome: "holds" }, `已满足 · 第 ${n} 次检查 · ${when}`);
        }
        if (a.until === "output_changes" && changed) {
          const summary = `输出变了：${label}在 ${when}（第 ${n} 次检查）的输出与上一次不同。\n之前：${clip(base.last || "（空）", 400)}\n现在：${clip(check.output || "（空）", 800)}`;
          return report("completed", summary, st, { ...facts, exitCode: check.exitCode, previous: clip(base.last ?? "", 2_000), outcome: "changed" }, `输出已变化 · 第 ${n} 次检查 · ${when}`);
        }
      } else {
        st = {
          ...base,
          v: 1,
          checks: n,
          cannotRun: base.cannotRun + 1,
          command: a.command,
          ...(a.updatedAt !== undefined ? { targetUpdatedAt: a.updatedAt } : base.targetUpdatedAt !== undefined ? { targetUpdatedAt: base.targetUpdatedAt } : {}),
          startedAt,
          backoffResetAt: now,
          unchangedChecks: 0,
          suspended: false,
          lastAt: now,
        };
        if (st.cannotRun >= 2) {
          const out = check.output ? `输出：${clip(check.output, 800)}` : "";
          return report("failed", `检查命令连续 ${st.cannotRun} 次没能运行，已停止监听：${label}（${check.why}，${when}）。${out}`, st, { ...facts, reason: check.why, outcome: "cannot_run" }, `检查命令没能运行 · 已停止 · ${when}`);
        }
      }

      if (a.deadlineAt !== undefined && now >= a.deadlineAt) {
        const last = check.ran ? `最后一次 exit ${check.exitCode}` : `最后一次${check.why}`;
        const out = check.output ? `，输出：${clip(check.output, 400)}` : "";
        return report(
          "failed",
          `到期仍未满足，已停止监听：${label}检查了 ${n} 次，截止时间 ${formatWhen(a.deadlineAt, cfg.timeZone)} 已过；${last}${out}。`,
          st,
          { ...facts, ...(check.ran ? { exitCode: check.exitCode } : { reason: check.why }), deadlineAt: a.deadlineAt, outcome: "deadline" },
          `到期未满足 · 已停止 · ${when}`,
        );
      }

      // Not yet: one reminder for the next look (whatever woke this one, the pending reminder is replaced), and a
      // line for the project's roster. Long stagnant polls gradually back off (30m → 300s, 60m → 600s).
      const stagnantMs = Math.max(0, now - backoffResetAt);
      const effectiveEverySec =
        stagnantMs >= PROBE.backoffAfter2Ms
          ? Math.max(a.everySec, PROBE.backoffSec2)
          : stagnantMs >= PROBE.backoffAfter1Ms
            ? Math.max(a.everySec, PROBE.backoffSec1)
            : a.everySec;
      const next = Math.min(now + effectiveEverySec * 1000, a.deadlineAt ?? Number.POSITIVE_INFINITY);
      await ports.cancelScheduled({ cellId: self, cancelGroup: PROBE.timers });
      await ports.scheduleSelf(
        { id: `${self}:probe:${snapshot.runId}`, type: PAYLOAD.timerFired, payload: { label: "再检查一次", data: { probe: n + 1 } } satisfies TimerFiredPayload },
        { deliverAt: next, cancelGroup: PROBE.timers },
      );
      const line = check.ran ? `未就绪 · 第 ${n} 次检查 · ${when}` : `检查命令没能运行（${check.why}），稍后再试 · 第 ${n} 次检查 · ${when}`;
      await ports.context.commit(self, { statePatches: { [KEYS.probe]: st, [CELL_STATUS_KEY]: statusLine(line, now) } });
      return "yielded_waiting";
    },
  };
}
