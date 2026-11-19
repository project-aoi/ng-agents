import {
  CELL_DIRECT_CHAT_KEY,
  NgError,
  PAYLOAD,
  parsePrincipal,
  pullCursorKey,
  type CellDirectChatState,
  type CellInspection,
  type Envelope,
  type EvidenceEntry,
  type InspectCellOptions,
} from "@ng/protocol";
import type { KernelCore } from "./core";

// The parent pulls; the worker is not asked to push. A worker that the owner talked to directly answers the owner
// and stops — nothing makes it summarise three rounds of changes for a parent it has half forgotten. What it did is
// on record anyway: every engine (API loop, Claude Code, Codex, Antigravity) mirrors inbound messages, assistant
// text, tool calls and results into evidence in one shape, so one reader serves all four.

const SUMMARY_CHARS = 12_000;
const FULL_CHARS = 40_000;
const MAX_CHARS = 120_000;

const one = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

function payloadText(env: Envelope): string {
  const p = env.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return typeof p === "string" ? p : "";
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

  const lines: string[] = [];
  const artifactIds = new Set<string>();
  const openCalls = new Map<string, number>();
  let used = 0;
  let toSeq = afterSeq;
  let more = false;
  let directChats = 0;
  const push = (seq: number, text: string): boolean => {
    if (used + text.length > maxChars && lines.length > 0) {
      more = true;
      return false;
    }
    lines.push(text);
    used += text.length + 1;
    toSeq = seq;
    return true;
  };

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
        openCalls.set(r.toolUseId, lines.length);
        break;
      }
      case "tool_result": {
        const at = openCalls.get(r.toolUseId);
        openCalls.delete(r.toolUseId);
        if (detail === "full") {
          line = `#${seq}   ${r.isError ? "failed" : "result"}: ${r.output}`;
        } else if (at !== undefined && lines[at] !== undefined) {
          // One line per step: the outcome is appended to the call it belongs to.
          const tail = r.isError ? ` → failed: ${one(r.output, 200)}` : ` → ${one(r.output.split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "ok", 120)}`;
          lines[at] += tail;
          used += tail.length;
          toSeq = seq;
        } else if (r.isError) {
          line = `#${seq}   ${r.name} failed: ${one(r.output, 200)}`;
        } else toSeq = Math.max(toSeq, seq);
        break;
      }
      case "external":
        line = `#${seq} ← external ${r.source}${r.title ? ` "${r.title}"` : ""}: ${one(r.text, 300)}`;
        break;
    }
    if (line === null) {
      if (!more) toSeq = Math.max(toSeq, seq);
      continue;
    }
    if (!push(seq, line)) break;
  }
  if (!more && records.length > 0) toSeq = records[records.length - 1]!.seq;

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
    ? `[cut at #${toSeq}: more follows — inspect_cell again with afterSeq ${toSeq}]`
    : detail === "summary" && lines.length > 0
      ? `[summary view — for the exact commands and outputs of a step: inspect_cell with detail "full" and afterSeq just before it; a res:// link in an output is read with read_resource]`
      : null;
  const text = [head.join(" · "), ...lines, ...(foot ? [foot] : [])].join("\n");

  // The cursor is the inspector's own, and only for cells below it: a desk that looks into a project's worker does
  // not make the project believe it has read anything.
  if (inspector && inspector !== targetId && toSeq > cursor && cells.ancestors(targetId).some((a) => a.id === inspector)) {
    context.commitSync(inspector, { statePatches: { [pullCursorKey(targetId)]: toSeq } });
  }
  return {
    cellId: targetId,
    title: target.title,
    state: activity?.state ?? target.status,
    fromSeq,
    toSeq: lines.length > 0 ? toSeq : 0,
    more,
    directChats,
    artifactIds: [...artifactIds],
    text,
  };
}
