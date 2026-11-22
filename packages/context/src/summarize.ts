import type { SummaryInput } from "./deps";
import { oneLine, safeTail } from "./text";

/** Extract references from the original strings, before any excerpt or JSON escaping. */
export function referencesIn(...values: unknown[]): string[] {
  const refs = new Set<string>();
  function visit(value: unknown) {
    if (typeof value === "string") {
      for (const match of value.matchAll(/(?:res|artifact):\/\/[^\s"'<>\x60\\\]\[(){}，。；、,;]+|\bart_[\w.-]+/gu))
        refs.add(match[0].replace(/[.!?]+$/, ""));
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) visit(child);
    }
  }
  for (const value of values) visit(value);
  return [...refs];
}

export function referenceLine(refs: readonly string[]): string {
  return refs.length ? "[references] " + refs.join(" ") : "";
}

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
  const refs = referenceLine(referencesIn(input.previousSummary, input.messages));
  const body = lines.filter(line => !line.startsWith("[references] ")).join("\n");
  const remaining = input.maxChars - refs.length - (refs ? 1 : 0);
  return [safeTail(body, remaining), refs].filter(Boolean).join("\n");
}
