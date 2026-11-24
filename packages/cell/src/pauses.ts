import { all, cellPrincipal, get, parsePrincipal, PAYLOAD, withTx, type ControlResult, type Envelope } from "@ng/protocol";
import type { KernelCore } from "./core";

/**
 * Who paused a cell, when, and with what words — kept on the cell (state `cell:pause`) and, for the cell that was
 * named, on its record. A pause used to leave nothing behind but a `cancelled` run: the desk resumed a project three
 * minutes after the owner had parked it, on an older "开始做吧", because the owner's "先停一下" was stored nowhere.
 */
export const CELL_PAUSE_KEY = "cell:pause";

export interface CellPauseState {
  pausedAt: number;
  /** Principal that paused it. */
  by: string;
  reason: "manual" | "parked";
  /** The cell the pause was addressed to (this cell, or the ancestor it was paused with). */
  root: string;
  /** The words that came with it (only on the root's record). */
  note?: string;
  resumedAt?: number;
  resumedBy?: string;
  /** The words that came with the resume (only on the root's record). */
  resumeNote?: string;
}

type PauseCore = Pick<KernelCore, "db" | "inbox" | "context" | "clock" | "cells" | "ownerPrincipal" | "dispatcher">;

const iso = (t: number) => `${new Date(t).toISOString().slice(0, 19)}Z`;

export function principalLabel(core: Pick<KernelCore, "ownerPrincipal">, principalId: string, self?: string): string {
  if (self !== undefined && principalId === cellPrincipal(self)) return "this cell itself";
  const p = parsePrincipal(principalId, core.ownerPrincipal);
  if (p.kind === "owner") return "the owner";
  // The act is the agent's; what the owner said is whatever is quoted with it. "The owner resumed it" for a resume
  // the owner never asked for made a project write "主人重新启动项目" into its notes (audit R01).
  if (p.kind === "agent") return "the owner's coding agent";
  return principalId.startsWith("cell:") ? `cell ${principalId.slice("cell:".length)}` : principalId;
}

const quoted = (note: string | undefined) => (note?.trim() ? `: "${note.trim().replace(/\s+/g, " ").slice(0, 600)}"` : "");

/** One line for whoever looks at a paused cell from outside (its parent's roster, inspect_cell). */
export function pauseLine(core: Pick<KernelCore, "ownerPrincipal" | "context">, cellId: string): string | null {
  const p = core.context.readStateSync<CellPauseState>(cellId, CELL_PAUSE_KEY);
  if (!p || p.resumedAt !== undefined) return null;
  if (p.root !== cellId) return `paused with ${p.root} since ${iso(p.pausedAt)}`;
  const what = p.reason === "parked" ? "parked for later" : "paused";
  return `${what} by ${principalLabel(core, p.by, cellId)} at ${iso(p.pausedAt)}${quoted(p.note)} — it stays as it is until someone resumes it; ask the owner before you do unless they have said so since`;
}

/** The pause just applied to `cellId` (and whatever was paused with it) goes on record. Call inside the control's transaction. */
export function recordPaused(core: PauseCore, cellId: string, how: { by: string; reason?: "manual" | "parked"; note?: string }): void {
  const { db, context, clock } = core;
  const now = clock.now();
  const reason = how.reason ?? "manual";
  const note = how.note?.trim() ? how.note.trim() : undefined;
  for (const { id } of all<{ id: string }>(db, "SELECT id FROM cells WHERE pause_owner = ? AND status = 'paused'", [cellId])) {
    const prev = context.readStateSync<CellPauseState>(id, CELL_PAUSE_KEY);
    // Paused earlier, for a reason of its own, and still paused: that record stands.
    if (id !== cellId && prev && prev.resumedAt === undefined) continue;
    const rec: CellPauseState = { pausedAt: now, by: how.by, reason, root: cellId, ...(id === cellId && note ? { note } : {}) };
    context.commitSync(id, { statePatches: { [CELL_PAUSE_KEY]: rec } });
  }
  const what = reason === "parked" ? "parked for later" : "paused";
  context.appendEvidenceSync(cellId, {
    kind: "system_note",
    runId: `control:pause:${now}`,
    at: now,
    text: `[${what} by ${principalLabel(core, how.by, cellId)} at ${iso(now)}${quoted(note)}. Whatever was running was stopped; messages wait until it is resumed.]`,
  });
}

/** A resume was applied to `cellId`: close the records it opened and say so on the cell's record. Returns the cells below it that woke with it. */
export function recordResumed(core: PauseCore, cellId: string, how: { by: string; note?: string }): string[] {
  const { context, clock, cells } = core;
  const now = clock.now();
  const woken: string[] = [];
  for (const c of [cells.require(cellId), ...cells.descendants(cellId, { status: ["active"] })]) {
    const prev = context.readStateSync<CellPauseState>(c.id, CELL_PAUSE_KEY);
    if (!prev || prev.resumedAt !== undefined || c.status !== "active") continue;
    const words = c.id === cellId && how.note?.trim() ? { resumeNote: how.note.trim() } : {};
    context.commitSync(c.id, { statePatches: { [CELL_PAUSE_KEY]: { ...prev, resumedAt: now, resumedBy: how.by, ...words } satisfies CellPauseState } });
    if (c.id !== cellId) woken.push(c.id);
  }
  context.appendEvidenceSync(cellId, {
    kind: "system_note",
    runId: `control:resume:${now}`,
    at: now,
    text: `[resumed by ${principalLabel(core, how.by, cellId)} at ${iso(now)}${quoted(how.note)}]`,
  });
  return woken;
}

/**
 * Inbox.control for pause and resume, with the record kept in the same transaction. After a resume the cells below
 * wait for the resumed cell's first Run (see Dispatcher.holdUntilSettled): the coordinator looks first.
 */
export function controlWithRecord(
  core: PauseCore,
  cellId: string,
  cmd: { action: "pause" | "resume"; principalId: string; pauseReason?: "manual" | "parked" },
  note?: string,
): ControlResult {
  return withTx(core.db, () => {
    const r = core.inbox.controlSync(cellId, cmd);
    if (!r.applied) return r;
    if (cmd.action === "pause") recordPaused(core, cellId, { by: cmd.principalId, ...(cmd.pauseReason ? { reason: cmd.pauseReason } : {}), ...(note ? { note } : {}) });
    else {
      const below = recordResumed(core, cellId, { by: cmd.principalId, ...(note ? { note } : {}) });
      if (below.length) core.dispatcher.holdUntilSettled(cellId, below);
    }
    return r;
  });
}

/** When the last Run of `cellId` other than `exceptRunId` started (0 when there was none). */
export function lastRunStart(core: Pick<KernelCore, "db">, cellId: string, exceptRunId = ""): number {
  return get<{ at: number }>(
    core.db,
    `SELECT at FROM evidence WHERE cell_id=? AND kind='run_boundary' AND json_extract(content,'$.phase')='start'
       AND coalesce(json_extract(content,'$.runId'),'')<>? ORDER BY seq DESC LIMIT 1`,
    [cellId, exceptRunId],
  )?.at ?? 0;
}

const resumedByOwner = (core: Pick<KernelCore, "ownerPrincipal">, by: string | undefined) =>
  by !== undefined && parsePrincipal(by, core.ownerPrincipal).kind === "owner";

/**
 * A note for the first Run of a cell after the pause that named it was lifted: who paused it, when and in what words,
 * and who resumed it with what. On a resumed CLI session the pause record is otherwise only a line among "earlier
 * events already handled". It states the facts; what a role makes of them is in its prompt.
 * `runId`: the Run that reads the note — its own start is already on record.
 */
export function resumeNote(core: Pick<KernelCore, "ownerPrincipal" | "context" | "db">, cellId: string, runId?: string): string | null {
  const p = core.context.readStateSync<CellPauseState>(cellId, CELL_PAUSE_KEY);
  if (!p || p.resumedAt === undefined || p.root !== cellId || lastRunStart(core, cellId, runId) >= p.resumedAt) return null;
  const what = p.reason === "parked" ? "parked this cell for later" : "paused this cell";
  const words = (note: string | undefined) => (note?.trim() ? `with the words "${note.trim().replace(/\s+/g, " ").slice(0, 600)}"` : "without a word");
  const start = (label: string) => `${label[0]!.toUpperCase()}${label.slice(1)}`;
  const by = principalLabel(core, p.resumedBy ?? "someone", cellId);
  return `[back from a pause — ${principalLabel(core, p.by, cellId)} ${what} at ${iso(p.pausedAt)}, ${words(p.note)}. ${start(by)} resumed it at ${iso(p.resumedAt)}, ${words(p.resumeNote)}.]`;
}

const INSTRUCTIONS: ReadonlySet<string> = new Set([PAYLOAD.cellTask, PAYLOAD.cellMessage, PAYLOAD.userMessage, PAYLOAD.controlSteer]);

/**
 * A note for a Run whose batch holds instructions from before the cell's last pause: the pause stopped them half-way
 * (or before they were read) and the resume put them back in the queue unchanged.
 */
export function prePauseNote(core: Pick<KernelCore, "ownerPrincipal" | "context">, cellId: string, incoming: readonly Envelope[]): string | null {
  const p = core.context.readStateSync<CellPauseState>(cellId, CELL_PAUSE_KEY);
  if (!p || p.resumedAt === undefined) return null;
  const old = incoming.filter((e) => INSTRUCTIONS.has(e.type) && e.createdAt < p.pausedAt);
  if (old.length === 0) return null;
  const root = p.root === cellId ? p : core.context.readStateSync<CellPauseState>(p.root, CELL_PAUSE_KEY);
  const rootNote = root?.note;
  const whom = p.root === cellId ? "this cell" : `${p.root} (above you, and you with it)`;
  const what = p.reason === "parked" ? "parked" : "paused";
  // Who brought it back decides what the old instructions are worth: the owner resuming it themselves is their go-ahead
  // for the work that was under way; anybody else resuming it is not.
  const resumedBy = root?.resumedBy ?? p.resumedBy;
  const who = resumedBy ? `${principalLabel(core, resumedBy, cellId)} resumed it` : "resumed";
  const stands = resumedByOwner(core, resumedBy)
    ? "The owner resumed it themselves, so what was under way goes on: a newer message wins; with none, these stand."
    : "They are shown again as they were: before acting on one, check what has been said since — a newer message wins, and if nothing confirms it still stands, ask whoever sent it.";
  return (
    `[from before a pause — ${principalLabel(core, p.by, cellId)} ${what} ${whom} at ${iso(p.pausedAt)}${quoted(rootNote)}; ${who} at ${iso(p.resumedAt)}. ` +
    `These message(s) below are older than that pause and were not finished when it came. ${stands}]\n` +
    old.map((e) => `- ${e.id} (${e.type}, sent ${iso(e.createdAt)})`).join("\n")
  );
}
