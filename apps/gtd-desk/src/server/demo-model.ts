// The demo's "model": a role-routed ScriptedModelClient. During the seed it answers the desk from a queue of turns the
// seed pushes before each item (so every scenario runs through the real tools and kernel); otherwise it answers by
// role from what the request contains — the desk with a few live heuristics (a note or link, a reminder, a redraft,
// anything else → an honest "演示模式" note), projects from a plan per project (what to do on their first task, on
// each worker result, on each word from the owner — and nothing on any other wake-up), workers and sources from fixed
// demo content. Every scripted cell acts only on the message that is meant for it: nothing re-dispatches on a stray
// wake-up (a stall check, a progress note), so nothing loops.

import { ScriptedModelClient, type ScriptTurn } from "@ng/loop";
import type { Clock, ModelRequest, ToolResultBlock } from "@ng/protocol";

export type DemoRole = "desk" | "project" | "worker" | "checker" | "hub" | "sensor" | "replyWatcher" | "unknown";

/** Openings of the presets' role prompts (presets/src/shared/prompts.ts), most specific first. */
const ROLE_MARKERS: ReadonlyArray<[DemoRole, string]> = [
  ["desk", "You are the owner's desk"],
  ["project", "You are a project on the owner's GTD workbench"],
  ["worker", "You are a one-shot worker"],
  ["checker", "You are a watcher on the owner's GTD workbench"],
  ["hub", "You are a hub on the owner's GTD workbench"],
  ["sensor", "You are a source on the owner's GTD workbench"],
  ["replyWatcher", "You wait for one person's reply"],
];

/** From the frozen system prompt, so the role is known even before the seed has run (e.g. right after a restart). */
export function roleOf(req: ModelRequest): DemoRole {
  for (const [role, marker] of ROLE_MARKERS) if (req.system.includes(marker)) return role;
  return "unknown";
}

/** A worker's canned outcome, matched by a key that appears in its task. */
export interface WorkerPlan {
  key: string;
  progress?: { text: string; done: number; total: number; label: string };
  /** A report it saves first (save_artifact with this id; `expectedVersion` when it extends an existing one). */
  artifact?: { id: string; title: string; body: string; expectedVersion?: number };
  result: string;
  /** Real milliseconds after the task was created before the result comes back (the work "takes" this long). */
  finishAfterMs?: number;
}

/** A turn, or one computed from the request (e.g. from an earlier tool result). */
export type PlannedTurn = ScriptTurn | ((req: ModelRequest) => ScriptTurn);

/**
 * What one project does, matched by a key that appears in its brief. Each list is played as consecutive tool calls in
 * one Run; a Run woken by anything else (a stall check, a progress note, a wake-up beyond the plan) does nothing.
 */
export interface ProjectPlan {
  key: string;
  /** On its first task. */
  first: PlannedTurn[];
  /** On the n-th child result it receives (in arrival order). */
  afterResult?: PlannedTurn[][];
  /** On the n-th message from the owner (or the owner's agent), e.g. "主人已完成：…". */
  afterOwner?: PlannedTurn[][];
}

/** A sensor rule: a watched message matching `match` is a hit. */
export interface SensorRule {
  match: RegExp;
  title: string;
  summary: string;
}

export const DEMO_ACK =
  "（演示模式）收到。现在没有接入真实的 Agent，这条只记在信箱里，不会被真正处理。安装 Claude Code / Codex / Antigravity CLI，或配置 ANTHROPIC_API_KEY 后重启，就能让 Agent 真正处理。";

// ==================== reading a request ====================

interface Block {
  type: string;
  head: string;
  body: string;
}

const HEAD = /^\[([a-z_.]+) · ([^\]]*)\]\n?/;

function textBlocks(req: ModelRequest, onlyLast: boolean): string[] {
  const users = req.messages.filter((m) => m.role === "user");
  const msgs = onlyLast ? users.slice(-1) : users;
  return msgs.flatMap((m) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])));
}

/** Text of the messages since the model last spoke: on a fresh Run, the batch that woke the cell (and the live notes). */
function sinceLastAssistant(req: ModelRequest): string[] {
  let i = req.messages.length - 1;
  while (i >= 0 && req.messages[i]!.role !== "assistant") i--;
  return req.messages.slice(i + 1).flatMap((m) => (m.role === "user" ? m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])) : []));
}

/** Envelopes as the context renders them: `[type · from … · at …]\nbody`. */
function envelopes(texts: readonly string[]): Block[] {
  const out: Block[] = [];
  for (const t of texts) {
    const m = HEAD.exec(t);
    if (m) out.push({ type: m[1]!, head: m[2]!, body: t.slice(m[0].length) });
  }
  return out;
}

/** The body's leading text, without the JSON of the remaining payload fields. */
function primaryText(body: string): string {
  const i = body.search(/\n\{\n/);
  return (i >= 0 ? body.slice(0, i) : body).trim();
}

function payloadJson(body: string): Record<string, unknown> {
  const i = body.search(/(^|\n)\{\n/);
  if (i < 0) return {};
  try {
    return JSON.parse(body.slice(i).trim()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function atOf(head: string): number | null {
  const m = /at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(head);
  return m ? Date.parse(m[1]!) : null;
}

/** The step after a tool call in the same Run (the request ends with tool results). */
function continuation(req: ModelRequest): { tool: string | null; results: ToolResultBlock[] } | null {
  const last = req.messages.at(-1);
  if (!last || last.role !== "user" || last.content.at(-1)?.type !== "tool_result") return null;
  const prev = [...req.messages].reverse().find((m) => m.role === "assistant");
  const call = prev?.content.findLast((b) => b.type === "tool_use");
  return { tool: call && call.type === "tool_use" ? call.name : null, results: last.content.filter((b): b is ToolResultBlock => b.type === "tool_result") };
}

const tool = (name: string, input: unknown = {}): ScriptTurn => ({ toolCalls: [{ name, input }] });

/** The model's own last tool call (name and input), if any. */
function lastToolCall(req: ModelRequest): { name: string; input: unknown } | null {
  const prev = [...req.messages].reverse().find((m) => m.role === "assistant");
  const call = prev?.content.findLast((b) => b.type === "tool_use");
  return call && call.type === "tool_use" ? { name: call.name, input: call.input } : null;
}

// ==================== time words ====================

/** Wall-clock parts of `ms` in `timeZone`. */
export function zonedParts(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p["weekday"] ?? "Sun");
  return { y: Number(p["year"]), mo: Number(p["month"]), d: Number(p["day"]), h: Number(p["hour"]), mi: Number(p["minute"]), wd };
}

/** The instant of a wall-clock time in `timeZone` (day overflow allowed: d = 32 is the next month). */
export function zonedTime(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(t, timeZone);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    t += guess - shown;
  }
  return t;
}

const CN_DIGITS: Readonly<Record<string, number>> = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const WEEKDAY: Readonly<Record<string, number>> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function cnNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  if (s.startsWith("十")) return 10 + (CN_DIGITS[s.slice(1)] ?? 0);
  if (s.endsWith("十")) return (CN_DIGITS[s[0]!] ?? 0) * 10;
  if (s.length === 3 && s[1] === "十") return (CN_DIGITS[s[0]!] ?? 0) * 10 + (CN_DIGITS[s[2]!] ?? 0);
  return s.length === 1 ? (CN_DIGITS[s] ?? null) : null;
}

/** "周五下午 3 点" / "明早 10 点" / "半小时后" / "20 分钟后" → an instant after `now` in `timeZone` (default tomorrow 09:00). */
export function parseWhen(text: string, now: number, timeZone: string): number {
  const rel = /(\d+|[一两二三四五六七八九十]+|半)\s*(个)?\s*(分钟|小时|钟头)后/.exec(text);
  if (rel) {
    const n = rel[1] === "半" ? 0.5 : (cnNumber(rel[1]!) ?? 1);
    return now + Math.round(n * (rel[3] === "分钟" ? 60_000 : 3_600_000));
  }
  const today = zonedParts(now, timeZone);
  let dayOffset: number | null = null;
  if (/后天/.test(text)) dayOffset = 2;
  else if (/明天|明早|明晚|明儿/.test(text)) dayOffset = 1;
  else if (/今天|今晚|今早|今儿/.test(text)) dayOffset = 0;
  const wd = /(下?)(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
  if (wd) {
    const target = WEEKDAY[wd[2]!]!;
    // "下周X" is X of the week after this one (weeks start on Monday); "周X" is the coming X.
    dayOffset = wd[1] === "下" ? 7 - ((today.wd + 6) % 7) + ((target + 6) % 7) : (target - today.wd + 7) % 7;
  }
  const hm = /(\d{1,2}|[一两二三四五六七八九十]{1,3})\s*(?:点|:|：|时)\s*(半|\d{1,2}(?!\s*(?:分钟|小时)))?/.exec(text);
  let hour = hm ? (cnNumber(hm[1]!) ?? 9) : 9;
  const minute = hm?.[2] === "半" ? 30 : hm?.[2] ? Number(hm[2]) : 0;
  if (/下午|晚上|傍晚|今晚|明晚/.test(text) && hour < 12) hour += 12;
  if (/中午/.test(text) && hour < 11) hour = 12;
  const day = 24 * 3_600_000;
  let at = zonedTime(timeZone, today.y, today.mo, today.d + (dayOffset ?? (hm ? 0 : 1)), hour, minute);
  if (at <= now && wd) at += 7 * day; // "周五" when this Friday's time has passed
  else if (at <= now && dayOffset === null) at += day; // "下午 3 点" when it has passed today
  return at > now ? at : now + 3_600_000;
}

/** "周五下午 3 点提醒我约牙医" → "约牙医". */
export function reminderText(text: string): string {
  const after = /提醒(?:我|一下)?(.+)$/.exec(text)?.[1]?.trim();
  const base = after && after.length >= 2 ? after : text.replace(/提醒(?:我|一下)?/, "");
  return base.replace(/^[，,：:\s]+|[。！!\s]+$/g, "").trim() || text.trim();
}

// ==================== the brain ====================

export interface DemoBrainOptions {
  clock: Clock;
  timeZone: string;
  ownerAddress?: string;
}

export class DemoBrain {
  readonly #clock: Clock;
  readonly #timeZone: string;
  readonly #owner: string;
  readonly #deskQueue: ScriptTurn[] = [];
  readonly workers: WorkerPlan[] = [];
  readonly projects: ProjectPlan[] = [];
  readonly sensorRules: SensorRule[] = [];
  /** Per project cell: its plan, the turns left of the current Run, and how many results / owner words it has seen. */
  readonly #projectState = new Map<string, { plan: ProjectPlan | null; queue: PlannedTurn[]; results: number; owner: number }>();
  /** Model calls answered, by role (diagnostics, tests). */
  readonly calls: Array<{ role: DemoRole; tool: string | null }> = [];
  readonly model: ScriptedModelClient;

  constructor(opts: DemoBrainOptions) {
    this.#clock = opts.clock;
    this.#timeZone = opts.timeZone;
    this.#owner = opts.ownerAddress ?? "channel:ui:owner";
    this.model = new ScriptedModelClient((req) => this.#answer(req), { models: { strong: "demo", fast: "demo" } });
  }

  /** Turns the desk gives on its next model calls, in order (the seed's script for one item). */
  queueDesk(...turns: ScriptTurn[]): void {
    this.#deskQueue.push(...turns);
  }

  /** Turns still queued (a seed step that left some behind was answered differently than scripted). */
  drainDesk(): ScriptTurn[] {
    return this.#deskQueue.splice(0);
  }

  #answer(req: ModelRequest): ScriptTurn {
    const role = roleOf(req);
    let turn: ScriptTurn;
    switch (role) {
      case "desk":
        turn = this.#deskQueue.shift() ?? this.#desk(req);
        break;
      case "project":
        turn = this.#project(req);
        break;
      case "worker":
        turn = this.#worker(req);
        break;
      case "checker":
        // A one-shot checker: one honest result, then it closes.
        turn =
          continuation(req) || !envelopes(sinceLastAssistant(req)).some((b) => b.type === "cell.task")
            ? {}
            : tool("report_to_parent", { kind: "result", text: "（演示模式）没有真正检查外部状态。", status: "failed" });
        break;
      case "sensor":
        turn = this.#sensor(req);
        break;
      case "replyWatcher":
        turn = continuation(req) ? {} : tool("update_watch");
        break;
      default:
        // The desk's hubs route nothing in the demo: they sit in the sources drawer.
        turn = {};
    }
    this.calls.push({ role, tool: turn.toolCalls?.[0]?.name ?? null });
    return turn;
  }

  // ---------- desk: live input ----------

  #desk(req: ModelRequest): ScriptTurn {
    const cont = continuation(req);
    if (cont) return cont.tool === "read_artifact" ? this.#redraft(req, cont.results) : {};
    const batch = envelopes(textBlocks(req, true));
    const revise = batch.find((b) => b.type === "approval.revise");
    if (revise) {
      const artifactId = payloadJson(revise.body)["artifactId"];
      if (typeof artifactId === "string") return tool("read_artifact", { artifactId });
      return {};
    }
    const handback = batch.find((b) => b.type === "handback");
    if (handback) {
      const original = (payloadJson(handback.body)["original"] as { payload?: { text?: string } } | undefined)?.payload?.text ?? "";
      return tool("present_to_owner", {
        title: `移回待确认：${clip(original || "一条归档记录", 24)}`,
        summary: `你把这条从归档记录里移回来了。原文：「${clip(original, 200)}」。（演示模式：没有真实模型，这里只把它原样放回来。）`,
        prep: { summary: "演示模式：没有做额外的检查。" },
      });
    }
    if (batch.some((b) => b.type === "timer.fired" && b.body.includes("每周回顾"))) return tool("review_week");
    const msg = batch.find((b) => b.type === "user.message");
    if (msg) {
      const text = primaryText(msg.body);
      const fromOwner = msg.head.includes("from channel:ui:");
      if (fromOwner && /提醒/.test(text)) {
        const at = parseWhen(text, this.#clock.now(), this.#timeZone);
        return tool("remind_me", { text: reminderText(text), at: new Date(at).toISOString(), effort: "15m" });
      }
      const url = /https?:\/\/\S+/.exec(text)?.[0];
      if (fromOwner && (url || /存一下|存进|存到|收藏|记一下|记下|笔记|阅读清单|备忘/.test(text))) {
        const rest = text.replace(url ?? "", "").replace(/(帮我)?(把这篇|这篇|这个)?(存一下|存进|存到|收藏|记一下|记下)(阅读清单|笔记)?[：:，,\s]*/g, "").trim();
        return tool("capture_note", {
          title: clip(rest || (url ? url.replace(/^https?:\/\//, "") : text), 40),
          ...(url ? { url } : { content: text }),
          list: url || /阅读/.test(text) ? "阅读清单" : "随手记",
        });
      }
      return tool("send_message", { to: this.#owner, text: DEMO_ACK, summary: "演示模式说明" });
    }
    const hit = batch.find((b) => b.type === "source.hit");
    if (hit) return tool("archive_notification", { title: clip(primaryText(hit.body), 40), detail: "演示模式：信源命中只做了归档" });
    return {};
  }

  /** Second step of a revise: rewrite the text the read returned, by the owner's instruction. */
  #redraft(req: ModelRequest, results: readonly ToolResultBlock[]): ScriptTurn {
    const read = results.map((r) => r.content).join("\n");
    const i = read.indexOf("\n---\n");
    const current = i >= 0 ? read.slice(i + 5) : read;
    const revise = envelopes(textBlocks(req, false)).findLast((b) => b.type === "approval.revise");
    const instruction = revise ? primaryText(revise.body) : "";
    return tool("draft_reply", {
      text: rewrite(current, instruction),
      prep: { summary: `按你的意见“${clip(instruction, 40)}”改了一版（演示模式：按固定规则改写）。` },
    });
  }

  // ---------- background roles: fixed demo content ----------

  // ---------- projects: a plan per project, acted on only for its own triggers ----------

  #project(req: ModelRequest): ScriptTurn {
    const cellId = req.metadata?.cellId ?? "?";
    let st = this.#projectState.get(cellId);
    if (!st) {
      const all = textBlocks(req, false).join("\n");
      st = { plan: this.projects.find((p) => all.includes(p.key)) ?? null, queue: [], results: 0, owner: 0 };
      this.#projectState.set(cellId, st);
    }
    const next = () => {
      const t = st!.queue.shift();
      return t === undefined ? {} : typeof t === "function" ? t(req) : t;
    };
    if (continuation(req)) return next();
    st.queue = [];
    const plan = st.plan;
    if (!plan) return {};
    for (const b of envelopes(sinceLastAssistant(req))) {
      if (b.type === "cell.task") st.queue.push(...plan.first);
      else if (b.type === "cell.result") st.queue.push(...(plan.afterResult?.[st.results++] ?? []));
      else if (b.type === "cell.message" && /principal (owner|agent:|cell:desk)/.test(b.head)) st.queue.push(...(plan.afterOwner?.[st.owner++] ?? []));
    }
    return next();
  }

  #worker(req: ModelRequest): ScriptTurn {
    const all = textBlocks(req, false);
    const task = envelopes(all).find((b) => b.type === "cell.task");
    const taskText = task?.body ?? all.join("\n");
    const plan = this.workers.find((w) => taskText.includes(w.key));
    const cont = continuation(req);
    // Only its task starts work: a later message (a follow-up, a stray wake-up) never makes it report again.
    if (!cont && !envelopes(sinceLastAssistant(req)).some((b) => b.type === "cell.task")) return {};
    if (!plan) {
      if (cont) return {};
      return tool("report_to_parent", { kind: "result", text: `（演示模式）这项工作没有真实执行：${clip(primaryText(taskText), 80)}` });
    }
    const last = lastToolCall(req);
    if (cont && last?.name === "report_to_parent" && (last.input as { kind?: string } | null)?.kind === "result") return {};
    const art = plan.artifact;
    const result = (): ScriptTurn => {
      const createdAt = task ? atOf(task.head) : null;
      const delayMs = plan.finishAfterMs && createdAt !== null ? Math.max(0, createdAt + plan.finishAfterMs - this.#clock.now()) : 0;
      return { ...tool("report_to_parent", { kind: "result", text: plan.result, ...(art ? { artifactId: art.id } : {}) }), ...(delayMs > 0 ? { delayMs } : {}) };
    };
    const save = (): ScriptTurn =>
      tool("save_artifact", { artifactId: art!.id, title: art!.title, format: "markdown", body: art!.body, ...(art!.expectedVersion !== undefined ? { expectedVersion: art!.expectedVersion } : {}) });
    if (!cont) {
      if (plan.progress) return tool("report_to_parent", { kind: "progress", text: plan.progress.text, progress: { done: plan.progress.done, total: plan.progress.total, label: plan.progress.label } });
      return art ? save() : result();
    }
    if (cont.tool === "report_to_parent") return art ? save() : result();
    if (cont.tool === "save_artifact") return result();
    return {};
  }

  #sensor(req: ModelRequest): ScriptTurn {
    if (continuation(req)) return {};
    const batch = envelopes(textBlocks(req, true));
    const msg = batch.findLast((b) => b.type === "user.message");
    if (!msg) return tool("no_hit");
    const text = primaryText(msg.body);
    const rule = this.sensorRules.find((r) => r.match.test(text));
    return rule ? tool("report_hit", { title: rule.title, summary: rule.summary, rawInput: text }) : tool("no_hit", { note: "无关消息" });
  }

}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** A deterministic stand-in for "rewrite this by the owner's spoken feedback". */
export function rewrite(draft: string, instruction: string): string {
  let text = draft.trim();
  if (/正式|礼貌|客气/.test(instruction)) {
    if (!/^您好/.test(text)) text = `您好，${text}`;
    if (!/谢谢|辛苦/.test(text)) text = `${text}\n\n谢谢！`;
  }
  if (/短|简洁|精简/.test(instruction)) {
    const first = text.split(/\n\s*\n/)[0] ?? text;
    text = first.length < text.length ? first : text;
  }
  if (!/正式|礼貌|客气|短|简洁|精简/.test(instruction) && instruction.trim()) {
    text = `${text}\n\n（按你的意见补充：${instruction.trim()}）`;
  }
  return text;
}
