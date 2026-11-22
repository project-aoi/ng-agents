import {
  CELL_DIRECT_CHAT_KEY,
  NgError,
  PAYLOAD,
  parsePrincipal,
  pullCursorKey,
  type ApprovalResolvedPayload,
  type CellDirectChatState,
  type CellInspection,
  type Envelope,
  type EvidenceEntry,
  type InspectCellOptions,
  type JobResultPayload,
} from "@ng/protocol";
import type { KernelCore } from "./core";

// The parent pulls; the worker is not asked to push. A worker that the owner talked to directly answers the owner
// and stops — nothing makes it summarise three rounds of changes for a parent it has half forgotten. What it did is
// on record anyway: every engine (API loop, Claude Code, Codex, Antigravity) mirrors inbound messages, assistant
// text, tool calls and results into evidence in one shape, so one reader serves all four.

const SUMMARY_CHARS = 12_000;
const FULL_CHARS = 40_000;
const MAX_CHARS = 120_000;
const RES_URI_RE = /res:\/\/[^\s\]\)"',]+/;

const one = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/**
 * Tail-focused brief for error tool outputs (BUG-034): real failure reasons and exit codes appear at the end, and
 * any `[res://...]` spill link must never be truncated away.
 */
function errorTail(output: string, max = 200): string {
  const uri = RES_URI_RE.exec(output)?.[0];
  const flat = output.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let tail = `…${flat.slice(flat.length - max)}`;
  if (uri && !tail.includes(uri)) {
    const link = ` [${uri}]`;
    const room = Math.max(40, max - link.length);
    tail = `…${flat.slice(flat.length - room)}${link}`;
  }
  return tail;
}

function payloadText(env: Envelope): string {
  const p = env.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return typeof p === "string" ? p : "";
  if (env.type === PAYLOAD.jobResult) {
    const jr = p as Partial<JobResultPayload>;
    const exit = jr.exitCode !== undefined && jr.exitCode !== null ? ` (exit ${jr.exitCode})` : "";
    const err = jr.error ? ` — ${one(jr.error, 120)}` : "";
    const log = jr.logUri ? ` [${jr.logUri}]` : "";
    const tail = jr.tail ? ` · ${errorTail(jr.tail, 120)}` : "";
    return `job ${jr.jobId ?? "?"} ${jr.state ?? "?"}${exit}: ${one(String(jr.command ?? ""), 100)}${err}${log}${tail}`;
  }
  if (env.type === PAYLOAD.approvalResolved) {
    const ar = p as Partial<ApprovalResolvedPayload> & { decision?: string };
    const act = ar.action as { type?: string; summary?: string } | undefined;
    const summary = act?.summary ? ` "${one(act.summary, 100)}"` : "";
    const receipt = ar.outcome?.receipt ? ` (${ar.outcome.receipt})` : "";
    const err = ar.outcome?.error ? ` — ${one(ar.outcome.error, 120)}` : "";
    const note = ar.note ? ` · note: ${one(ar.note, 100)}` : "";
    return `approval ${ar.actionId ?? "?"} ${ar.decision ?? ar.status ?? "?"}${receipt}${summary}${err}${note}`;
  }
  for (const k of ["text", "instruction", "message", "summary", "label", "reason", "detail"]) if (typeof p[k] === "string" && p[k]) return p[k] as string;
  return "";
}

/** What a tool call was about, in a few words: the command, the path, the patch's files. */
function callBrief(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return typeof input === "string" ? one(input, 160) : "";
  const o = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "file_path", "path", "filePath", "pattern", "query", "url", "title", "to", "artifactId", "cellId"]) {
    if (typeof o[k] === "string" && o[k]) return one(o[k] as string, 200);
  }
  if (Array.isArray(o["changes"])) {
    return one((o["changes"] as unknown[]).map((c) => (c && typeof c === "object" ? `${String((c as Record<string, unknown>)["kind"] ?? "change")} ${String((c as Record<string, unknown>)["path"] ?? "?")}` : "")).join(", "), 240);
  }
  if (typeof o["input"] === "string") return one(o["input"], 160);
  const json = JSON.stringify(o);
  return json === "{}" ? "" : one(json, 160);
}

export function inspectCell(
  core: Pick<KernelCore, "cells" | "context" | "readModel" | "ownerPrincipal">,
  targetId: string,
  opts: InspectCellOptions = {},
  who: { inspectorId?: string } = {},
): CellInspection {
  const { cells, context } = core;
  const target = cells.get(targetId);
  if (!target) throw new NgError("not_found", `there is no cell "${targetId}"`);
  const detail = opts.detail === "full" ? "full" : "summary";
  const maxChars = Math.min(MAX_CHARS, Math.max(1_000, opts.maxChars ?? (detail === "full" ? FULL_CHARS : SUMMARY_CHARS)));
  const inspector = who.inspectorId;
  const cursor = inspector ? (context.readStateSync<number>(inspector, pullCursorKey(targetId)) ?? 0) : 0;
  const afterSeq = Math.max(0, Math.floor(opts.afterSeq ?? cursor));
  const records: EvidenceEntry[] = context.listEvidenceSync(targetId, { afterSeq });
  const isPerson = (principalId: string) => {
    const kind = parsePrincipal(principalId, core.ownerPrincipal).kind;
    return kind === "owner" || kind === "agent";
  };

  const formatted: Array<{ seq: number; text: string }> = [];
  const artifactIds = new Set<string>();
  const openCalls = new Map<string, number>();
  let directChats = 0;

  for (const { seq, record: r } of records) {
    let line: string | null = null;
    switch (r.kind) {
      case "run_boundary":
        if (r.phase === "end" && r.outcome && r.outcome !== "completed") line = `#${seq} (run ended: ${r.outcome}${r.error ? ` — ${one(r.error, 200)}` : ""})`;
        break;
      case "inbound": {
        const env = r.envelope;
        // Kernel bookkeeping that woke it says nothing about the work.
        if (env.type === PAYLOAD.stalledCheck || env.type === PAYLOAD.runContinue) break;
        const person = isPerson(env.principalId) && (env.type === PAYLOAD.cellMessage || env.type === PAYLOAD.userMessage || env.type === PAYLOAD.controlSteer);
        if (person) directChats++;
        const from = person ? `the owner, directly (${env.principalId})` : env.type === PAYLOAD.cellTask ? "its task" : `${env.type} from ${env.from}`;
        const body = payloadText(env);
        line = `#${seq} ← ${from}: ${detail === "full" ? body : one(body, 600)}`;
        break;
      }
      case "system_note":
        // Steers are recorded as notes by the loops; the owner's are the ones worth a parent's attention.
        line = `#${seq} ← note: ${detail === "full" ? r.text : one(r.text, 400)}`;
        break;
      case "assistant_text":
        if (r.text.trim()) line = `#${seq} → said: ${detail === "full" ? r.text.trim() : one(r.text, 800)}`;
        break;
      case "tool_call": {
        const id = (r.input as { artifactId?: unknown } | null)?.artifactId;
        if ((r.name === "save_artifact" || r.name === "patch_artifact") && typeof id === "string") artifactIds.add(id);
        const brief = detail === "full" ? JSON.stringify(r.input ?? {}) : callBrief(r.name, r.input);
        line = `#${seq} · ${r.name}${brief ? `: ${detail === "full" ? brief : one(brief, 240)}` : ""}`;
        openCalls.set(r.toolUseId, formatted.length);
        break;
      }
      case "tool_result": {
        const at = openCalls.get(r.toolUseId);
        openCalls.delete(r.toolUseId);
        if (detail === "full") {
          line = `#${seq}   ${r.isError ? "failed" : "result"}: ${r.output}`;
        } else if (at !== undefined && formatted[at] !== undefined) {
          // One line per step: error outputs take the tail 200 chars preserving any [res://...] link.
          // Keep formatted[at].seq at the original tool_call seq so formatted stays monotonically ordered under parallel calls.
          const tail = r.isError ? ` → failed: ${errorTail(r.output, 200)}` : ` → ${one(r.output.split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "ok", 120)}`;
          formatted[at]!.text += tail;
        } else if (r.isError) {
          line = `#${seq}   ${r.name} failed: ${errorTail(r.output, 200)}`;
        }
        break;
      }
      case "external":
        line = `#${seq} ← external ${r.source}${r.title ? ` "${r.title}"` : ""}: ${one(r.text, 300)}`;
        break;
    }
    if (line !== null) formatted.push({ seq, text: line });
  }

  // Head 20% + Tail 80% truncation when formatted lines exceed maxChars (BUG-034).
  const clipMiddle = (text: string, budget: number): string => {
    if (text.length <= budget) return text;
    const headLen = Math.max(40, Math.floor(budget * 0.2));
    const tailLen = Math.max(80, budget - headLen - 40);
    return `${text.slice(0, headLen)}\n…[truncated ${text.length - headLen - tailLen} chars — showing head 20% + tail 80%]…\n${text.slice(text.length - tailLen)}`;
  };
  const totalChars = formatted.reduce((n, e) => n + e.text.length + 1, 0);
  let lines: string[];
  let more = false;
  const toSeq = records.length > 0 ? records[records.length - 1]!.seq : afterSeq;
  let resumeAfterSeq = toSeq;

  if (totalChars <= maxChars) {
    lines = formatted.map((e) => e.text);
  } else if (formatted.length === 1) {
    lines = [clipMiddle(formatted[0]!.text, maxChars)];
  } else {
    more = true;
    const headBudget = Math.max(160, Math.floor(maxChars * 0.2));
    const tailBudget = Math.max(400, maxChars - headBudget - 120);
    const headEntries: Array<{ seq: number; text: string }> = [];
    let headUsed = 0;
    for (const e of formatted) {
      if (headUsed + e.text.length + 1 > headBudget) {
        if (headEntries.length === 0) headEntries.push({ seq: e.seq, text: clipMiddle(e.text, headBudget) });
        break;
      }
      headEntries.push(e);
      headUsed += e.text.length + 1;
    }
    const tailEntries: Array<{ seq: number; text: string }> = [];
    let tailUsed = 0;
    for (let i = formatted.length - 1; i >= headEntries.length; i--) {
      const e = formatted[i]!;
      if (tailUsed + e.text.length + 1 > tailBudget) {
        if (tailEntries.length === 0) tailEntries.unshift({ seq: e.seq, text: clipMiddle(e.text, tailBudget) });
        break;
      }
      tailEntries.unshift(e);
      tailUsed += e.text.length + 1;
    }
    const omittedCount = formatted.length - headEntries.length - tailEntries.length;
    if (omittedCount <= 0) {
      more = false;
      lines = [...headEntries.map((e) => e.text), ...tailEntries.map((e) => e.text)];
    } else {
      const firstOmitted = formatted[headEntries.length]!.seq;
      const lastOmitted = formatted[formatted.length - tailEntries.length - 1]!.seq;
      resumeAfterSeq = headEntries[headEntries.length - 1]?.seq ?? afterSeq;
      const marker = `…[${omittedCount} record(s) #${firstOmitted}–#${lastOmitted} omitted — showing head 20% + tail 80%; inspect_cell with afterSeq ${resumeAfterSeq} to read the middle]`;
      lines = [...headEntries.map((e) => e.text), marker, ...tailEntries.map((e) => e.text)];
    }
  }

  for (const a of context.listArtifactsSync(targetId)) artifactIds.add(a.artifactId);
  const activity = core.readModel.activityOf([targetId]).get(targetId);
  const chat = context.readStateSync<CellDirectChatState>(targetId, CELL_DIRECT_CHAT_KEY);
  const fromSeq = lines.length > 0 ? afterSeq + 1 : 0;
  const head = [
    `${targetId}${target.title ? ` "${target.title}"` : ""} — ${activity?.why ?? target.status}`,
    target.spec.cwd ? `directory ${target.spec.cwd}` : null,
    lines.length > 0 ? `records #${afterSeq + 1}–#${toSeq}` : `nothing new after #${afterSeq}`,
    directChats > 0 ? `the owner spoke to it directly ${directChats} time(s) in this stretch` : chat?.total ? "the owner has spoken to it directly before this stretch" : null,
    artifactIds.size > 0 ? `artifacts: ${[...artifactIds].join(", ")}` : null,
  ].filter(Boolean);
  const foot = more
    ? `[middle omitted between #${resumeAfterSeq} and tail: inspect_cell with afterSeq ${resumeAfterSeq} to inspect omitted steps]`
    : detail === "summary" && lines.length > 0
      ? `[summary view — for the exact commands and outputs of a step: inspect_cell with detail "full" and afterSeq just before it; a res:// link in an output is read with read_resource]`
      : null;
  const text = [head.join(" · "), ...lines, ...(foot ? [foot] : [])].join("\n");

  // The cursor is the inspector's own, and only for cells below it: a desk that looks into a project's worker does
  // not make the project believe it has read anything.
  if (inspector && inspector !== targetId && resumeAfterSeq > cursor && afterSeq <= cursor && cells.ancestors(targetId).some((a) => a.id === inspector)) {
    context.commitSync(inspector, { statePatches: { [pullCursorKey(targetId)]: resumeAfterSeq } });
  }
  return {
    cellId: targetId,
    title: target.title,
    state: activity?.state ?? target.status,
    fromSeq,
    toSeq: lines.length > 0 ? toSeq : 0,
    more,
    ...(more ? { resumeAfterSeq } : {}),
    directChats,
    artifactIds: [...artifactIds],
    text,
  };
}
