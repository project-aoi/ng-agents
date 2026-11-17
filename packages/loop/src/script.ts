import {
  gtdKeys,
  PAYLOAD,
  type Clock,
  type PromptSnapshot,
  type RunOutcome,
  type RunPorts,
  type SourceHitPayload,
  type SourceRecord,
} from "@ng/protocol";

export const SCRIPT_PREFIX = "script:";

const RAW_INPUT_CAP = 20_000;
const SUMMARY_CAP = 1_000;

export interface ScriptRunInput {
  snapshot: PromptSnapshot;
  ports: RunPorts;
  signal: AbortSignal;
  args: Record<string, unknown>;
  clock: Clock;
  timeoutMs: number;
}

/**
 * `script:<path>` entry: zero-token check run through the cell's workspace (`bash`, so bounds must include it).
 *
 * - exit 0, empty output → nothing to report, silent `completed`.
 * - exit 0, output → `external` evidence, then `source.hit` to the parent — unless the cell's `gtd:source` record is
 *   in `observe` mode (observation is only recorded, never posted to the desk).
 * - non-zero exit → `system_note` evidence and a thrown error (the kernel releases the claim; repeated failures end
 *   as a dead letter the kernel escalates).
 * A `gtd:source` record, if present, gets runCount/lastRunAt/hitCount/lastHitAt/status/lastError updated.
 *
 * The script sees `NG_CELL_ID`, `NG_RUN_ID` and `NG_ARGS` (JSON of `processor.args`); the workspace merges stderr into
 * the output, so a check should write diagnostics only when it means to report.
 */
export async function runScriptEntry(path: string, input: ScriptRunInput): Promise<RunOutcome> {
  const { snapshot, ports, signal, args, clock } = input;
  const cellId = snapshot.cellId;
  const runId = snapshot.runId;
  const command = scriptCommand(path, { NG_CELL_ID: cellId, NG_RUN_ID: runId, NG_ARGS: JSON.stringify(args) });
  const res = await ports.workspace.exec("bash", { command, timeoutMs: input.timeoutMs }, signal);
  if (signal.aborted) return "cancelled";

  const exitCode = res.exitCode ?? 0;
  const output = res.output.trim();
  const source = await ports.context.readState<SourceRecord>(cellId, gtdKeys.source);
  const now = clock.now();
  const saveSource = async (patch: Partial<SourceRecord>) => {
    if (!source) return;
    const next: SourceRecord = { ...source, ...patch, runCount: source.runCount + 1, lastRunAt: now, updatedAt: now };
    await ports.context.commit(cellId, { statePatches: { [gtdKeys.source]: next } });
  };

  if (exitCode !== 0) {
    const tail = output.slice(-2_000);
    await ports.context.appendEvidence(cellId, {
      kind: "system_note",
      runId,
      at: now,
      text: `[script ${path} exited with code ${exitCode}]\n${tail}`,
    });
    await saveSource({ status: "error", lastError: `exit ${exitCode}: ${tail.slice(-300)}` });
    throw new Error(`script:${path} exited with code ${exitCode}`);
  }
  if (!output) {
    await saveSource({ status: "ok" });
    return "completed";
  }

  const title = source?.title ?? snapshot.spec.title ?? path;
  await ports.context.appendEvidence(cellId, { kind: "external", runId, at: now, source: `script:${path}`, title, text: output });
  if (source?.mode !== "observe") {
    const payload: SourceHitPayload = {
      sourceCellId: cellId,
      title,
      summary: output.length > SUMMARY_CAP ? `${output.slice(0, SUMMARY_CAP)}…` : output,
      rawInput: output.slice(0, RAW_INPUT_CAP),
    };
    await ports.emitToParent(PAYLOAD.sourceHit, payload);
  }
  await saveSource({ status: "ok", hitCount: (source?.hitCount ?? 0) + 1, lastHitAt: now });
  return "completed";
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Picks an interpreter by extension so the script need not be executable. */
export function scriptCommand(path: string, env: Record<string, string>): string {
  const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  const q = shellQuote(path);
  let runner: string;
  if (ext === "sh" || ext === "bash") runner = `bash ${q}`;
  else if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "ts" || ext === "mts") runner = `node ${q}`;
  else if (ext === "py") runner = `python3 ${q}`;
  else runner = shellQuote(path.startsWith("/") || path.startsWith("./") || path.startsWith("../") ? path : `./${path}`);
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return [...assignments, runner].join(" ");
}
