import { all, parsePrincipal, PAYLOAD, speaks, type Envelope } from "@ng/protocol";
import { projectTimeline } from "./agents";
import type { ProjectionInput } from "./common";

export interface DeskWords {
  /** The timeline item (r<seq>) the words stand in. */
  id: string;
  text: string;
  at: number;
}

/** A person speaking to the desk, as opposed to deciding a card or a cell, source or timer waking it. */
const SPEECH: ReadonlySet<string> = new Set([PAYLOAD.userMessage, PAYLOAD.cellMessage, PAYLOAD.controlSteer]);
const MAX_ITEMS = 200;

/**
 * What the desk told the owner since `since` in turns that no person's words started or joined: the notices it sent in
 * such a turn, or its last words when it sent none. An answer to the owner in the web view is read there and an answer
 * to their agent comes back with the call; these have no such way to an owner who only talks to their agent.
 *
 * Whether a turn was prompted is read from the messages that turn was given (the records carry its run id), never from
 * the timeline around it. A pure read.
 */
export function unpromptedDeskWords(input: ProjectionInput, since: number): DeskWords[] {
  const { kernel } = input;
  const deskId = kernel.deskCellId;
  const replies = (projectTimeline(input, deskId, { limit: MAX_ITEMS })?.items ?? []).flatMap((i) => (i.kind === "assistant_reply" && i.at >= since ? [i] : []));
  if (replies.length === 0) return [];

  const runs = new Map(
    all<{ seq: number; run_id: string }>(
      kernel.db,
      "SELECT seq, run_id FROM evidence WHERE cell_id = ? AND run_id IS NOT NULL AND seq IN (SELECT value FROM json_each(?))",
      [deskId, JSON.stringify(replies.map((r) => r.seq))],
    ).map((r) => [r.seq, r.run_id]),
  );
  const isPerson = (principalId: string) => ["owner", "agent"].includes(parsePrincipal(principalId, kernel.ownerPrincipal).kind);
  const prompted = new Set(
    all<{ run_id: string; content: string }>(
      kernel.db,
      "SELECT run_id, content FROM evidence WHERE cell_id = ? AND kind IN ('inbound','system_note') AND run_id IN (SELECT value FROM json_each(?))",
      [deskId, JSON.stringify([...new Set(runs.values())])],
    ).flatMap(({ run_id, content }) => {
      const r = JSON.parse(content) as { envelope?: Envelope; envelopeId?: string };
      // A steer taken in mid-turn is on record as a note that names its envelope.
      const env = r.envelope ?? (r.envelopeId ? kernel.inbox.listMessagesSync({ cellId: deskId, envelopeId: r.envelopeId, limit: 1 })[0]?.envelope : undefined);
      return env && SPEECH.has(env.type) && isPerson(env.principalId) && speaks(env) ? [run_id] : [];
    }),
  );

  const turns = new Map<string, typeof replies>();
  for (const reply of replies) {
    const run = runs.get(reply.seq);
    if (run && !prompted.has(run)) turns.set(run, [...(turns.get(run) ?? []), reply]);
  }
  return [...turns.values()]
    .flatMap((said) => (said.some((r) => r.toOwner) ? said.filter((r) => r.toOwner) : said.slice(-1)))
    .map((r) => ({ id: r.id, text: r.text, at: r.at }));
}
