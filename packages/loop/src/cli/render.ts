import { messageText, type ModelMessage, type PromptSnapshot } from "@ng/protocol";

const TOOL_TEXT_CAP = 4_000;

/** Marker Context puts at the start of a fork_prefix child's fork note (see @ng/context hydrate). */
export const FORK_NOTE_PREFIX = "[fork] Everything above is the context of cell";

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[${text.length - max} more chars]` : text;
}

/** A provider-neutral message list as a plain transcript, for priming a fresh CLI session with the cell's history. */
export function renderTranscript(messages: readonly ModelMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const lines: string[] = [];
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text.trim()) lines.push(b.text);
      } else if (b.type === "tool_use") {
        lines.push(`[tool call ${b.name}] ${clip(JSON.stringify(b.input) ?? "", TOOL_TEXT_CAP)}`);
      } else {
        lines.push(`[tool result${b.isError ? " (error)" : ""}] ${clip(b.content, TOOL_TEXT_CAP)}`);
      }
    }
    if (lines.length) parts.push(`### ${m.role === "user" ? "Input" : "You (earlier)"}\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** The snapshot's volatile tail (children roster + the new batch) as the text of one user turn. */
export function tailText(snapshot: PromptSnapshot): string {
  return snapshot.tail.messages
    .map((m) => messageText(m))
    .filter((t) => t.trim())
    .join("\n\n");
}

/** Index of the fork note in a fork_prefix child's history (the messages from there on are the child's own), or -1. */
export function forkNoteIndex(history: readonly ModelMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "user" && m.content.some((b) => b.type === "text" && b.text.startsWith(FORK_NOTE_PREFIX))) return i;
  }
  return -1;
}

export const HISTORY_HEADER =
  "[Earlier conversation of this cell, restored from the kernel's record (your previous CLI session is not available). Tool calls shown here already happened; do not repeat them.]";
export const HISTORY_FOOTER = "[End of the earlier conversation. New input follows.]";

/** First prompt of a fresh session: rendered history (if any), then the new input. */
export function freshPrompt(history: readonly ModelMessage[], input: string): string {
  if (history.length === 0) return input;
  return `${HISTORY_HEADER}\n\n${renderTranscript(history)}\n\n${HISTORY_FOOTER}\n\n${input}`;
}
