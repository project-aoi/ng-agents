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
  "cell.task": "instruction",
  "cell.message": "text",
  "cell.direct_chat": "text",
  "job.warning": "message",
  "kernel.stalled_check": "detail",
  "kernel.wait_timeout": "reason",
};
/**
 * Kernel notices are instructions as much as data: a fixed sentence says what the cell is expected to do with them
 * (docs/05 guards 1 and 2), then the payload follows as usual.
 */
const LEAD: Readonly<Record<string, string>> = {
  "cell.direct_chat":
    "The owner said this directly to one of your cells (named below), not to you. It is already with that cell — do not forward it. Take it into your own picture of the work: the plan, your notes, what you tell the next cell.",
  "approval.revise":
    "The owner asked for a revision to the pending card below (the card stays open until updated). If an artifactId is given, read_artifact first to see the latest version (including any edits the owner already made), then update it with save_artifact or patch_artifact using that expectedVersion; if you resubmit a card or proposal, pass the same subjectKey so you update this card instead of creating a duplicate.",
  "job.warning":
    "One of your running background jobs triggered a warning (for example, it has been quiet for a long time and may be waiting for interactive input). Inspect it with job_observe, send stdin with job_input if it is waiting on a prompt, or stop it with job_cancel; then end your turn without reporting the whole task finished unless the job is actually done.",
  "kernel.stalled_check":
    'Nothing is moving this project forward any more. Look at where it stands and do exactly one of these now: start the next step; record what it waits for (a card or an action for the owner, a subscription or timer for an outside event, a wait on a cell that will answer); park it (finish_project with outcome "someday", or pause_self for a non-project cell); or finish it (finish_project, or complete_self for a non-project cell). You get this notice once per stall — if you end this run without doing one of them, the project just stays stalled.',
  "kernel.arbitration_unanswered":
    "An arbitration decision was already handled, but the waiting cell(s) listed below still have no answer from you. Reply to each one now with send_message (passing its waitId as refId) or raise a decision card covering them; if any remain unanswered when this run ends, the system will escalate directly to the owner.",
  "kernel.continue":
    "Your previous run stopped at its step limit before the work was finished. Continue from where you stopped — do not start over, and do not repeat what is already done.",
  "kernel.wait_timeout":
    "Nobody answered the wait below in time. Check the current state yourself first (it may have been resolved without a message), then decide: ask again, raise it to the owner, or go on without it.",
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
  // A message from outside can be handed back or answered one by one, also when several arrive in one batch.
  if (env.type === "user.message" && env.from.startsWith("channel:")) head.push(`id ${env.id}`);
  // What a person said straight to this cell (or to one of its children) carries its own id too: both entry points —
  // the workbench and the owner's agent — refer to messages by it.
  else if (env.from === "kernel:control" && (env.type === "user.message" || env.type === "cell.message")) head.push(`id ${env.id}`);
  const payload = renderPayload(env);
  const lead = LEAD[env.type];
  const body = lead ? (payload ? `${lead}\n${payload}` : lead) : payload;
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

/** Entries without depth/cwd render exactly as before those fields existed (the roster text is part of the prompt). */
export function rosterMessage(roster: readonly ChildSummary[]): ModelMessage {
  const lines = roster.map((c) => {
    const parts = [c.cellId];
    if (c.title) parts.push(`"${c.title}"`);
    if (c.preset) parts.push(c.preset);
    parts.push(c.status);
    if (c.cwd) parts.push(`cwd ${c.cwd}`);
    const indent = "  ".repeat(Math.max(0, (c.depth ?? 1) - 1));
    return `${indent}- ${parts.join(" · ")}${c.statusLine ? `: ${c.statusLine}` : ""}`;
  });
  return textMessage("user", `[in-flight child cells: live status, not part of the conversation]\n${lines.join("\n")}`);
}
