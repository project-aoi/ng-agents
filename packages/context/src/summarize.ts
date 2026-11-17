import type { SummaryInput } from "./deps";
import { oneLine } from "./text";

/**
 * Default summariser: no model, fully deterministic. One line per folded block (role + a clipped excerpt), appended
 * to the previous summary, keeping the most recent lines within `maxChars`. Crude, but it keeps the package usable
 * offline and its output never changes for the same input.
 */
export function truncatingSummary(input: SummaryInput): string {
  const lines: string[] = input.previousSummary ? input.previousSummary.split("\n") : [];
  for (const m of input.messages) {
    for (const b of m.content) {
      if (b.type === "text") lines.push(`${m.role}: ${oneLine(b.text, 240)}`);
      else if (b.type === "tool_use") lines.push(`assistant called ${b.name} ${oneLine(JSON.stringify(b.input ?? {}), 160)}`);
      else lines.push(`${b.isError ? "tool error" : "tool result"}: ${oneLine(b.content, 160)}`);
    }
  }
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (size + line.length + 1 > input.maxChars) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  if (dropped > 0) {
    if (kept[0]?.startsWith("… (") === true) kept.shift();
    kept.unshift(`… (${dropped} older lines dropped)`);
  }
  return kept.join("\n");
}
