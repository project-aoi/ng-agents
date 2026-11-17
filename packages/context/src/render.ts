import {
  textMessage,
  type ChildSummary,
  type ContentBlock,
  type Envelope,
  type EvidenceOf,
  type ModelMessage,
  type StepOrExternalEvidence,
} from "@ng/protocol";
import { prettyJson } from "./text";

// Everything here must be a pure function of stored data: history is rebuilt from evidence on every hydrate and must
// come out byte-identical each time (provider prompt caching). No clocks, no locale, no Map/Set iteration order.

/** Payload field shown as the message body for kernel payload types; the rest of the payload follows as JSON. */
const PRIMARY_FIELD: Readonly<Record<string, string>> = {
  "user.message": "text",
  "control.steer": "message",
  "cell.result": "summary",
  "cell.progress": "text",
  "timer.fired": "label",
  "source.hit": "summary",
  "approval.revise": "instruction",
  handback: "reason",
};

/** Adapter-specific raw events are noise for the model and can be large. */
const OMITTED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "user.message": ["raw"],
};

function isoTime(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}

function renderPayload(env: Envelope): string {
  const payload = env.payload;
  if (typeof payload === "string") return payload;
  if (payload === null || payload === undefined) return "";
  if (typeof payload !== "object" || Array.isArray(payload)) return prettyJson(payload);
  const obj = payload as Record<string, unknown>;
  const primary = PRIMARY_FIELD[env.type];
  const omit = new Set(OMITTED_FIELDS[env.type] ?? []);
  let text = "";
  if (primary !== undefined && typeof obj[primary] === "string") {
    text = obj[primary] as string;
    omit.add(primary);
  }
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!omit.has(k) && v !== undefined) rest[k] = v;
  if (Object.keys(rest).length === 0) return text;
  const json = prettyJson(rest);
  return text ? `${text}\n${json}` : json;
}

/**
 * One inbound envelope as user text. Used for the batch in the tail *and* for `inbound` evidence in history, so a
 * batch reappears byte-identically in the next Run's history.
 */
export function renderEnvelope(env: Envelope): string {
  const head = [env.type, `from ${env.from}`, `principal ${env.principalId}`];
  if (env.threads && env.threads.length > 0) head.push(`thread ${env.threads.join(", ")}`);
  if (env.kind === "result") head.push("result");
  if (env.delivery === "silent_inject") head.push("background");
  if (env.producerModel) head.push(`model ${env.producerModel}`);
  head.push(`at ${isoTime(env.createdAt)}`);
  const body = renderPayload(env);
  return body ? `[${head.join(" · ")}]\n${body}` : `[${head.join(" · ")}]`;
}

export function renderExternal(r: Pick<EvidenceOf<"external">, "source" | "title" | "uri" | "text">): string {
  const head = ["external", r.source];
  if (r.title) head.push(r.title);
  if (r.uri) head.push(r.uri);
  return `[${head.join(" · ")}]\n${r.text}`;
}

/** Approximate rendered size of one record (chars), used for compaction budgets. */
export function recordSize(r: StepOrExternalEvidence): number {
  switch (r.kind) {
    case "inbound":
      return renderEnvelope(r.envelope).length;
    case "assistant_text":
      return r.text.length;
    case "tool_call":
      return r.name.length + (JSON.stringify(r.input) ?? "").length;
    case "tool_result":
      return r.output.length;
    case "external":
      return renderExternal(r).length;
    case "system_note":
      return r.text.length;
    case "run_boundary":
      return 0;
  }
}

export function messagesSize(messages: readonly ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") n += b.text.length;
      else if (b.type === "tool_use") n += b.name.length + (JSON.stringify(b.input) ?? "").length;
      else n += b.content.length;
    }
  }
  return n;
}

export const NO_RESULT_TEXT = "[no result was recorded for this tool call: the run ended before it returned]";
export const FORK_PENDING_TEXT =
  "[this call was still in flight when the current cell was forked from it; its result went to the parent cell]";
export const HISTORY_START_TEXT = "[earlier context is not available]";

export interface RenderOptions {
  /** How tool calls still open at the end of `records` are answered: "error" (crashed Run) or "fork" (fork point). */
  openAtEnd: "error" | "fork";
}

/**
 * Evidence → messages, one message per record (never merged here, so appending records only ever appends messages).
 * Rules (contract/context.ts "Who writes what"): inbound/external/system_note → user text; assistant_text/tool_call →
 * assistant; tool_result → user tool_result; run_boundary → nothing. A tool call left open is answered with a
 * synthetic result at the first run_boundary or new assistant turn after it (or at the end), a position that does
 * not move when more records are appended. A tool_result without an open call becomes plain user text.
 */
export function renderRecords(records: readonly StepOrExternalEvidence[], opts: RenderOptions): ModelMessage[] {
  const out: ModelMessage[] = [];
  let open: string[] = [];
  let lastRole: ModelMessage["role"] | null = null;

  const closeOpen = (text: string, isError: boolean) => {
    if (open.length === 0) return;
    const blocks: ContentBlock[] = open.map((id) =>
      isError ? { type: "tool_result", toolUseId: id, content: text, isError: true } : { type: "tool_result", toolUseId: id, content: text },
    );
    out.push({ role: "user", content: blocks });
    open = [];
  };

  for (const r of records) {
    switch (r.kind) {
      case "run_boundary":
        closeOpen(NO_RESULT_TEXT, true);
        lastRole = null;
        break;
      case "assistant_text":
      case "tool_call": {
        if (lastRole !== "assistant") closeOpen(NO_RESULT_TEXT, true);
        lastRole = "assistant";
        if (r.kind === "assistant_text") {
          if (r.text) out.push(textMessage("assistant", r.text));
        } else {
          out.push({ role: "assistant", content: [{ type: "tool_use", id: r.toolUseId, name: r.name, input: r.input ?? {} }] });
          open.push(r.toolUseId);
        }
        break;
      }
      case "tool_result": {
        lastRole = "user";
        const i = open.indexOf(r.toolUseId);
        if (i >= 0) {
          open.splice(i, 1);
          out.push({
            role: "user",
            content: [
              r.isError
                ? { type: "tool_result", toolUseId: r.toolUseId, content: r.output, isError: true }
                : { type: "tool_result", toolUseId: r.toolUseId, content: r.output },
            ],
          });
        } else {
          out.push(textMessage("user", `[tool result · ${r.name} · ${r.toolUseId}]\n${r.output}`));
        }
        break;
      }
      case "inbound":
        lastRole = "user";
        out.push(textMessage("user", renderEnvelope(r.envelope)));
        break;
      case "external":
        lastRole = "user";
        out.push(textMessage("user", renderExternal(r)));
        break;
      case "system_note":
        lastRole = "user";
        if (r.text) out.push(textMessage("user", r.text));
        break;
    }
  }
  if (opts.openAtEnd === "fork") closeOpen(FORK_PENDING_TEXT, false);
  else closeOpen(NO_RESULT_TEXT, true);
  return out;
}

export function summaryMessage(summary: string, uptoSeq: number): ModelMessage {
  return textMessage(
    "user",
    `[summary of the earlier conversation: older turns (evidence up to #${uptoSeq}) were compacted; ` +
      `search_history and read_resource can recover details]\n${summary}`,
  );
}

export function rosterMessage(roster: readonly ChildSummary[]): ModelMessage {
  const lines = roster.map((c) => {
    const parts = [c.cellId];
    if (c.title) parts.push(`"${c.title}"`);
    if (c.preset) parts.push(c.preset);
    parts.push(c.status);
    return `- ${parts.join(" · ")}${c.statusLine ? `: ${c.statusLine}` : ""}`;
  });
  return textMessage("user", `[in-flight child cells: live status, not part of the conversation]\n${lines.join("\n")}`);
}
