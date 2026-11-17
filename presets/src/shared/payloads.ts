import { z } from "zod";
import { registerPayloadType, type ClarifyCard, type ItemSource, type WaitingSet } from "@ng/protocol";

// Preset-private envelope types between a coordinator root, its watchers and the desk. Registered process-wide
// (unknown types are quarantined by the Inbox); the schema objects are module constants so registering twice is a no-op.

export const GTD_PAYLOAD = {
  /** desk → root ("stop"), app → root ("sync"), root → watcher ("raise_nudge"). */
  command: "gtd.command",
  /** watcher → root: overdue / nudged / extended / nudge_closed. */
  watch: "gtd.watch",
} as const;

export type GtdCommand =
  | { command: "stop"; reason?: string }
  /** app → root: the owner changed the item's records directly (e.g. checked off its last action): re-check them. */
  | { command: "sync" }
  | { command: "raise_nudge"; waiting: WaitingSet; itemTitle: string; source: ItemSource; rawInput: ClarifyCard["rawInput"] };

export type WatchEvent =
  | { event: "overdue"; slot: string; dueAt: number }
  | { event: "nudged"; slot: string; dueAt: number }
  | { event: "extended"; slot: string; dueAt: number }
  | { event: "nudge_closed"; slot: string; dueAt: number; outcome: string };

const commandSchema = z.looseObject({ command: z.enum(["stop", "raise_nudge", "sync"]) });
const watchSchema = z.looseObject({ event: z.enum(["overdue", "nudged", "extended", "nudge_closed"]), slot: z.string(), dueAt: z.number() });

export function registerGtdPayloads(): void {
  registerPayloadType(GTD_PAYLOAD.command, commandSchema);
  registerPayloadType(GTD_PAYLOAD.watch, watchSchema);
}
