import { BALL_LABEL } from "../../shared/api";
import { CELL_PAUSE_KEY, type CellPauseState } from "@ng/cell";
import { CHANNEL_LABELS, parseAddress, parsePrincipal, type ItemSource, type Progress, type WaitingSet } from "@ng/protocol";
import { relativeTimeZh, type ArtifactDTO, type ButtonDTO, type DecisionDTO, type ProgressDTO, type SourceInfoDTO, type WaitingDTO } from "../../shared/api";
import type { DeskKernel } from "./common";
import { dueText } from "./time";

/** A moment as the owner reads it: their own clock, not UTC ("11月23日 23:36"). */
export function localTime(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", { ...(timeZone ? { timeZone } : {}), month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${get("month")}月${get("day")}日 ${get("hour")}:${get("minute")}`;
}

export interface PauseInfo {
  text: string;
  by: string;
  at: number;
  note: string | null;
  parked: boolean;
}

/**
 * Who paused or parked a cell, when and with what words (audit E05) — in plain Chinese, for everyone who looks at it
 * from outside: the overview, get_project, the answer to "activate", the project list. null when it is not paused.
 */
export function pauseInfoOf(kernel: DeskKernel, cellId: string, timeZone?: string): PauseInfo | null {
  const cell = kernel.getCell(cellId);
  const p = kernel.context.readStateSync<CellPauseState>(cellId, CELL_PAUSE_KEY);
  if (!cell || cell.status !== "paused" || !p || p.resumedAt !== undefined) return null;
  const who = parsePrincipal(p.by, kernel.ownerPrincipal);
  const by = who.kind === "owner" ? "主人" : who.kind === "agent" ? "主人的编码助手" : p.by === `cell:${cellId}` ? "项目自己" : who.kind === "cell" ? `后台（${who.cellId}）` : p.by;
  const note = p.note?.trim() ? p.note.trim() : null;
  const parked = p.reason === "parked";
  return { by, at: p.pausedAt, note, parked, text: `${by}于 ${localTime(p.pausedAt, timeZone)} ${parked ? "放进以后再说" : "暂停"}${note ? `，当时的话：「${note.length > 200 ? `${note.slice(0, 200)}…` : note}」` : "，没有留话"}` };
}

export function channelLabel(channelId: string): string {
  return CHANNEL_LABELS[channelId] ?? channelId;
}

/** The channel part of a `channel:<id>:<target>` address, labelled. */
export function channelLabelOfAddress(addr: string): string {
  const p = parseAddress(addr);
  return p?.kind === "channel" ? channelLabel(p.channelId) : "外部";
}

export function sourceInfo(s: ItemSource | undefined | null): SourceInfoDTO | null {
  if (!s || typeof s !== "object" || typeof s.label !== "string") return null;
  return {
    label: s.label,
    at: typeof s.at === "number" ? s.at : 0,
    ...(s.channelId ? { channelId: s.channelId } : {}),
    ...(s.uri ? { uri: s.uri } : {}),
  };
}

export const ownerLabel = (o: keyof typeof BALL_LABEL): string => BALL_LABEL[o];

export function progressDTO(p: Progress | undefined | null, fallbackLabel?: string): ProgressDTO | null {
  if (!p || typeof p.done !== "number" || typeof p.total !== "number" || p.total <= 0) return null;
  const label = p.label ?? fallbackLabel ?? null;
  return { done: p.done, total: p.total, label, text: label ? `${label} ${p.done}/${p.total}` : `${p.done}/${p.total}` };
}

/** "已回 2/3 · 剩 供应商 C 明天到期" */
export function waitingDTO(w: WaitingSet | undefined | null, now: number): WaitingDTO | null {
  // A waiting action with nobody to count replies from (a plan step "等行政确认…" without a watch) shows as plain text.
  if (!w || !Array.isArray(w.parties) || w.parties.length === 0) return null;
  const parties = w.parties.filter((p) => p && typeof p.label === "string");
  const replied = parties.filter((p) => p.replied).length;
  const total = parties.length;
  const open = parties.filter((p) => !p.replied);
  const dueAt = w.dueAt ?? null;
  const parts = [`已回 ${replied}/${total}`];
  const due = open.map((p) => p.dueAt ?? dueAt).filter((d): d is number => typeof d === "number");
  const earliest = due.length ? Math.min(...due) : null;
  if (open.length > 0 && open.length < total) {
    parts.push(`剩 ${open.map((p) => p.label).join("、")}${earliest !== null ? ` ${dueText(earliest, now)}` : ""}`);
  } else if (open.length > 0 && earliest !== null) {
    parts.push(dueText(earliest, now));
  }
  return {
    description: w.description ?? "",
    replied,
    total,
    join: w.join === "any" ? "any" : "all",
    dueAt,
    text: parts.join(" · "),
    parties: parties.map((p) => ({ label: p.label, replied: Boolean(p.replied), repliedAt: p.repliedAt ?? null, dueAt: p.dueAt ?? null })),
  };
}

/** Earliest deadline still open in a waiting set (overall or per party). */
export function waitingDeadline(w: WaitingSet | undefined | null): number | null {
  if (!w) return null;
  const due = [w.dueAt, ...(w.parties ?? []).filter((p) => !p.replied).map((p) => p.dueAt)].filter((d): d is number => typeof d === "number");
  return due.length ? Math.min(...due) : null;
}

const DECISION_START = /^\s*>\s*\[!(?:DECISION|决策)\]\s*(.*)$/i;

/**
 * Passages the owner must decide on. Convention for drafts: a markdown alert block
 *   > [!DECISION] 第 2.3 节：两个迁移方案二选一
 *   > A：…
 *   > B：…
 * (also `[!决策]`). The presets' prompts describe the marker as a line "right before" the passage, so a marker without
 * quoted lines takes the paragraph that follows it (up to a blank line or the next marker). The editor highlights
 * lines startLine..endLine.
 */
export function parseDecisions(body: string): DecisionDTO[] {
  const lines = body.split("\n");
  const out: DecisionDTO[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DECISION_START.exec(lines[i]!);
    if (!m) continue;
    const start = i;
    const text: string[] = [];
    while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]!) && !DECISION_START.test(lines[i + 1]!)) {
      i++;
      text.push(lines[i]!.replace(/^\s*>\s?/, ""));
    }
    if (text.length === 0) {
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== "" && !DECISION_START.test(lines[i + 1]!)) {
        i++;
        text.push(lines[i]!);
      }
    }
    out.push({ label: m[1]?.trim() || "需要你拍板", text: text.join("\n").trim(), startLine: start, endLine: i });
  }
  return out;
}

export function button(b: Omit<ButtonDTO, "primary" | "group"> & Partial<Pick<ButtonDTO, "primary" | "group">>): ButtonDTO {
  return { primary: false, group: "main", ...b };
}

export function post(path: string, body?: Record<string, unknown>): NonNullable<ButtonDTO["endpoint"]> {
  return body === undefined ? { method: "POST", path } : { method: "POST", path, body };
}

const enc = encodeURIComponent;

export const ARTIFACT_EDITOR_PREFIX = "desk:artifact-editor:";
/** Desk-cell state: which control-plane entrance saved the current version of a document (only when it was the owner's agent). */
export const artifactEditorKey = (artifactId: string) => `${ARTIFACT_EDITOR_PREFIX}${artifactId}`;

/**
 * The passages of a project plan (a json document) that are marked for the owner to decide: the same `> [!DECISION]`
 * convention, looked for in the plan's free text. Line numbers are those of the background text.
 */
export function planDecisions(data: unknown): DecisionDTO[] {
  if (!data || typeof data !== "object") return [];
  const p = data as { background?: unknown; outcome?: unknown; agentContext?: unknown };
  return [p.background, p.outcome, p.agentContext].flatMap((t) => (typeof t === "string" ? parseDecisions(t) : []));
}

export function artifactDTO(kernel: DeskKernel, artifactId: string, now: number): ArtifactDTO | null {
  const a = kernel.context.getArtifactSync(artifactId);
  if (!a) return null;
  const editor = a.updatedBy === "human" ? kernel.context.readStateSync<{ version: number; principalId: string }>(kernel.deskCellId, artifactEditorKey(artifactId)) : null;
  const who = a.updatedBy !== "human" ? "后台" : editor?.version === a.version ? "你的编码助手（按你的意思）" : "你";
  const verb = a.updatedBy === "human" ? "修改" : a.version === 1 ? "起草" : "更新";
  const body = a.content.body;
  return {
    artifactId,
    version: a.version,
    format: a.content.format,
    ...(a.content.title !== undefined ? { title: a.content.title } : {}),
    body,
    ...(a.content.data !== undefined ? { data: a.content.data } : {}),
    updatedBy: a.updatedBy,
    updatedByLabel: who,
    updatedAt: a.updatedAt,
    versionText: `v${a.version} · ${relativeTimeZh(a.updatedAt, now)}由${who}${verb}`,
    versions: kernel.context.listArtifactVersionsSync(artifactId).map((v) => ({ version: v.version, updatedBy: v.updatedBy, createdAt: v.createdAt })),
    parked: kernel.context.listParkedSync(artifactId).map((p) => ({
      id: p.id,
      basedOnVersion: p.basedOnVersion,
      format: p.content.format,
      ...(p.content.title !== undefined ? { title: p.content.title } : {}),
      body: p.content.body,
      ...(p.note !== undefined ? { note: p.note } : {}),
      createdAt: p.createdAt,
      dismiss: button({ id: "dismiss_parked", label: "已合并，移除", endpoint: post(`/api/artifacts/${enc(artifactId)}/parked/${enc(p.id)}/dismiss`) }),
    })),
    decisions: a.content.format === "markdown" || a.content.format === "text" ? parseDecisions(body) : a.content.format === "json" ? planDecisions(a.content.data) : [],
    save: { method: "PUT", path: `/api/artifacts/${enc(artifactId)}` },
  };
}

export { enc };
