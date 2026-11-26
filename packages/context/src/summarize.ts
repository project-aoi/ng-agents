import type { SummaryInput } from "./deps";
import { oneLine, safeTail } from "./text";

/** Extract references from the original strings, before any excerpt or JSON escaping. */
const REF_PATTERN = /(?:res|artifact):\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./:@-]+(?!…|\.\.\.)|artifact:\/\/[A-Za-z0-9_.-]+(?:@\d+)?(?!…|\.\.\.)|\bart_(?:[A-Za-z_][A-Za-z0-9_.-]*|[0-9a-z]{8,})\b(?!…|\.\.\.)/g;

export function referencesIn(...values: unknown[]): string[] {
  const refs = new Set<string>();
  function visit(value: unknown) {
    if (typeof value === "string") {
      for (const match of value.matchAll(REF_PATTERN)) {
        const cleaned = match[0].replace(/[.:/-]+$/, "");
        if (cleaned.startsWith("res://") && !/^res:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(cleaned)) continue;
        if (cleaned.startsWith("artifact://") && cleaned.length <= "artifact://".length) continue;
        refs.add(cleaned);
      }
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) visit(child);
    }
  }
  for (const value of values) visit(value);
  const coveredArtIds = new Set<string>();
  for (const r of refs) {
    const m = /^artifact:\/\/(art_[A-Za-z0-9_.-]+?)(?:@\d+)?$/.exec(r);
    if (m?.[1]) coveredArtIds.add(m[1]);
  }
  return [...refs].filter((r) => !coveredArtIds.has(r));
}

export function referenceLine(refs: readonly string[]): string {
  return refs.length ? "[references] " + refs.join(" ") : "";
}

/**
 * Fit whole references within `maxChars` without ever slicing mid-URI.
 * Formal `art_*` / `artifact://` references take priority; temporary `res://` spill links keep the newest entries first.
 */
export function boundedReferenceLine(refs: readonly string[], maxChars: number): { line: string; dropped: string[] } {
  if (refs.length === 0 || maxChars <= "[references] ".length) return { line: "", dropped: [...refs] };
  const isFormal = (r: string) => r.startsWith("art_") || r.startsWith("artifact://");
  const formal = refs.filter(isFormal);
  const ephemeral = refs.filter((r) => !isFormal(r));
  // Select newest formal refs first, then newest res:// refs, then restore original relative order.
  const keptSet = new Set<string>();
  let used = "[references]".length;
  for (const r of [...[...formal].reverse(), ...[...ephemeral].reverse()]) {
    if (used + 1 + r.length <= maxChars) {
      keptSet.add(r);
      used += 1 + r.length;
    }
  }
  const kept = refs.filter((r) => keptSet.has(r));
  const dropped = refs.filter((r) => !keptSet.has(r));
  return { line: kept.length ? "[references] " + kept.join(" ") : "", dropped };
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
  const refBudget = Math.min(1_200, Math.max(96, Math.floor(input.maxChars / 5)));
  const refs = boundedReferenceLine(referencesIn(input.previousSummary, input.messages), refBudget).line;
  const body = lines.filter(line => !line.startsWith("[references] ") && !line.startsWith("[original task]") && !line.startsWith("[project goal]")).join("\n");
  const remaining = Math.max(0, input.maxChars - refs.length - (refs ? 1 : 0));
  return [safeTail(body, remaining), refs].filter(Boolean).join("\n");
}
