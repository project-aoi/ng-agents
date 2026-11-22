import { relativeTimeZh } from "../shared/api";

const DAY = 24 * 3_600_000;

function midnight(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "今天 14:00" · "明天 09:00" · "11月20日 16:00" — the same wording the server uses in its own strings. */
export function whenText(at: number, now: number): string {
  const diff = Math.round((midnight(at) - midnight(now)) / DAY);
  if (diff === 0) return `今天 ${hhmm(at)}`;
  if (diff === 1) return `明天 ${hhmm(at)}`;
  if (diff === -1) return `昨天 ${hhmm(at)}`;
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(at)}`;
}

/** Timeline stamps: "16:12" today, otherwise "昨天 16:12" · "11月20日 16:12". */
export function clockText(at: number, now: number): string {
  return midnight(at) === midnight(now) ? hhmm(at) : whenText(at, now);
}

/** One line, at most `max` characters, for chips that quote a longer text. */
export function excerpt(text: string, max = 40): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "今天到期" · "明天到期" · "3 天后到期" · "已超时 2 天" */
export function dueText(dueAt: number, now: number): string {
  const diff = Math.round((midnight(dueAt) - midnight(now)) / DAY);
  if (dueAt < now) return diff <= -1 ? `已超时 ${-diff} 天` : "已超时";
  if (diff === 0) return "今天到期";
  if (diff === 1) return "明天到期";
  return `${diff} 天后到期`;
}

export function ago(at: number | null | undefined, now: number): string {
  if (!at) return "从未";
  return relativeTimeZh(at, now);
}

/**
 * Some labels fall back to a raw delivery address ("channel:memory:wang-lei"); the owner only needs the person or
 * group part, never the address syntax (docs/03 铁律 1).
 */
export function prettyTarget(label: string): string {
  const m = /^channel:[^:]+:(.+)$/.exec(label);
  if (m?.[1]) return m[1] === "*" ? "对方" : m[1];
  const inbox = /^inbox:/.test(label);
  return inbox ? "后台分身" : label;
}

const DECISION_START = /^\s*>\s*\[!(?:DECISION|决策)\]\s*(.*)$/i;

export interface DecisionRange {
  label: string;
  startLine: number;
  endLine: number;
}

/**
 * Same convention as the server (`> [!DECISION] label` blockquote, continued by `>` lines), re-run on the text in
 * the editor so the highlight follows the owner's edits instead of the last saved version.
 */
export function parseDecisions(body: string): DecisionRange[] {
  const lines = body.split("\n");
  const out: DecisionRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DECISION_START.exec(lines[i]!);
    if (!m) continue;
    const start = i;
    while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]!)) i++;
    out.push({ label: m[1]?.trim() || "需要你拍板", startLine: start, endLine: i });
  }
  return out;
}

/** Character offsets of a line range, for selecting a decision passage in the textarea. */
export function lineOffsets(body: string, startLine: number, endLine: number): [number, number] {
  const lines = body.split("\n");
  let start = 0;
  for (let i = 0; i < startLine && i < lines.length; i++) start += lines[i]!.length + 1;
  let end = start;
  for (let i = startLine; i <= endLine && i < lines.length; i++) end += lines[i]!.length + (i < endLine ? 1 : 0);
  return [start, end];
}

const RAW_KIND_LABEL = {
  message: "原始消息",
  voice_transcript: "语音转写",
  monitor_summary: "监控摘要",
  system: "触发原因",
} as const;

export function rawKindLabel(kind: keyof typeof RAW_KIND_LABEL): string {
  return RAW_KIND_LABEL[kind];
}

/** Ids for capture retries: the server accepts the same clientId once. */
export function clientId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `web-${c.randomUUID()}`;
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
