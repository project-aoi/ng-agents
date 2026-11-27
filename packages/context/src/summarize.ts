import type { SummaryInput } from "./deps";
import { oneLine, safeHead, safeTail } from "./text";

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

/** Read-only tools whose verbose raw results should not evict conclusions/decisions during compaction. */
const NOISY_READ_TOOLS = new Set(["read_state", "read_resource", "read_artifact", "search_history", "inspect_cell", "job_observe"]);

/** Extract key paths, branches, PR/MR numbers, and commit hashes without mangling them. */
const KEY_PATH_PATTERN = /(?:\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,}|(?:feat|fix|chore|refactor|docs|release|hotfix)\/[A-Za-z0-9._/-]+|(?:MR|PR)\s*[!#]\d+|https?:\/\/[^\s)>"']+)/g;

function extractKeyPaths(...values: unknown[]): string[] {
  const found = new Set<string>();
  function visit(v: unknown) {
    if (typeof v === "string") {
      for (const m of v.matchAll(KEY_PATH_PATTERN)) {
        const s = m[0].replace(/[.,;:]+$/, "");
        if (s.length >= 4 && s.length <= 140) found.add(s);
      }
    } else if (v && typeof v === "object") {
      for (const c of Object.values(v)) visit(c);
    }
  }
  for (const v of values) visit(v);
  return [...found];
}

function dedupeRecent(lines: readonly string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < maxItems; i--) {
    const line = lines[i]!.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.reverse();
}

function fitSection(heading: string, lines: readonly string[], budget: number): string {
  if (lines.length === 0 || budget <= heading.length + 4) return "";
  const kept: string[] = [];
  let used = heading.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const item = `- ${lines[i]!}`;
    if (used + 1 + item.length > budget) {
      // Never drop the entire section when the newest item alone exceeds the tight budget: clip it cleanly.
      if (kept.length === 0) {
        const avail = budget - heading.length - 4; // "\n- " + "…"
        if (avail >= 8) kept.push(`- ${safeHead(lines[i]!, avail)}…`);
      }
      break;
    }
    kept.push(item);
    used += 1 + item.length;
  }
  if (kept.length === 0) return "";
  return `${heading}\n${kept.reverse().join("\n")}`;
}

/**
 * Trim a structured summary body to `maxChars` without letting `safeTail` decapitate `## 目标与要求`.
 * Preserves goals, blockers, and key paths by shedding oldest lines from `## 进展与结论` first.
 */
export function fitStructuredBody(body: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (body.length <= maxChars) return body;
  if (!body.startsWith("## ")) return safeTail(body, maxChars);
  const goals: string[] = [];
  const progress: string[] = [];
  const blockers: string[] = [];
  const paths: string[] = [];
  let section: "goals" | "progress" | "blockers" | "paths" = "progress";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "## 目标与要求") { section = "goals"; continue; }
    if (line === "## 进展与结论") { section = "progress"; continue; }
    if (line === "## 阻塞与错误") { section = "blockers"; continue; }
    if (line === "## 关键路径与标识") { section = "paths"; continue; }
    const item = line.startsWith("- ") ? line.slice(2).trim() : line;
    if (!item) continue;
    if (section === "goals") goals.push(item);
    else if (section === "blockers") blockers.push(item);
    else if (section === "paths") paths.push(item);
    else progress.push(item);
  }
  const goalSec = fitSection("## 目标与要求", goals, goals.length ? Math.floor(maxChars * 0.25) : 0);
  const blockerSec = fitSection("## 阻塞与错误", blockers, blockers.length ? Math.floor(maxChars * 0.22) : 0);
  const pathSec = fitSection("## 关键路径与标识", paths, paths.length ? Math.floor(maxChars * 0.18) : 0);
  const used =
    (goalSec ? goalSec.length + 1 : 0) +
    (blockerSec ? blockerSec.length + 1 : 0) +
    (pathSec ? pathSec.length + 1 : 0);
  const progressSec = fitSection("## 进展与结论", progress, Math.max(0, maxChars - used));
  const rebuilt = [goalSec, progressSec, blockerSec, pathSec].filter(Boolean).join("\n");
  if (rebuilt.length > 0 && rebuilt.length <= maxChars) return rebuilt;
  return safeTail(body, maxChars);
}

/**
 * Structured deterministic summariser (M7): replaces raw 8KB tail-chopping with 4-part semantic grouping
 * (goals/decisions, completed progress & key tool actions, blockers/errors, key paths & references) while filtering
 * noisy read-only tool dumps so long-lived cells stay readable across many compactions without telegraph jargon.
 */
export function structuredSummary(input: SummaryInput): string {
  const goals: string[] = [];
  const progress: string[] = [];
  const blockers: string[] = [];
  const toolNames = new Map<string, string>();

  if (input.previousSummary) {
    let section: "goals" | "progress" | "blockers" | "paths" = "progress";
    for (const raw of input.previousSummary.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("[references] ") || line.startsWith("[original task]") || line.startsWith("[project goal]")) continue;
      if (line === "## 目标与要求") { section = "goals"; continue; }
      if (line === "## 进展与结论") { section = "progress"; continue; }
      if (line === "## 阻塞与错误") { section = "blockers"; continue; }
      if (line === "## 关键路径与标识") { section = "paths"; continue; }
      if (section === "paths") continue;
      const body = line.startsWith("- ") ? line.slice(2).trim() : line;
      if (!body) continue;
      if (section === "goals" || /^user:\s*\[(?:user\.message|cell\.task|approval\.revise)\b/.test(body)) goals.push(body);
      else if (section === "blockers" || body.startsWith("tool error")) blockers.push(body);
      else progress.push(body);
    }
  }

  for (const m of input.messages) {
    for (const b of m.content) {
      if (b.type === "text") {
        const text = oneLine(b.text, 220);
        if (!text) continue;
        if (m.role === "user") {
          if (text.startsWith("[user.message") || text.startsWith("[cell.task") || text.startsWith("[approval.revise")) {
            goals.push(`user: ${text}`);
          } else {
            progress.push(`user: ${text}`);
          }
        } else {
          progress.push(`assistant: ${text}`);
        }
      } else if (b.type === "tool_use") {
        toolNames.set(b.id, b.name);
        if (!NOISY_READ_TOOLS.has(b.name)) {
          progress.push(`assistant called ${b.name} ${oneLine(JSON.stringify(b.input ?? {}), 140)}`);
        }
      } else {
        const toolName = toolNames.get(b.toolUseId);
        if (b.isError) {
          blockers.push(`tool error${toolName ? ` (${toolName})` : ""}: ${oneLine(b.content, 160)}`);
        } else if (!toolName || !NOISY_READ_TOOLS.has(toolName)) {
          const snippet = oneLine(b.content, 140);
          if (snippet) progress.push(`tool result: ${snippet}`);
        }
      }
    }
  }

  const refBudget = Math.min(1_200, Math.max(96, Math.floor(input.maxChars / 5)));
  const refs = boundedReferenceLine(referencesIn(input.previousSummary, input.messages), refBudget).line;
  const bodyBudget = Math.max(0, input.maxChars - refs.length - (refs ? 1 : 0));

  const goalItems = dedupeRecent(goals, 6);
  const blockerItems = dedupeRecent(blockers, 8);
  const progressItems = dedupeRecent(progress, 32);
  const pathItems = extractKeyPaths(input.previousSummary, input.messages).slice(-12);
  const pathBudget = Math.floor(bodyBudget * 0.2);
  const fittedPaths: string[] = [];
  for (let i = pathItems.length - 1; i >= 0; i--) {
    const candidate = `## 关键路径与标识\n- ${[pathItems[i]!, ...fittedPaths].join(" | ")}`;
    if (candidate.length > pathBudget) break;
    fittedPaths.unshift(pathItems[i]!);
  }
  const cappedPathLine = fittedPaths.length > 0 ? `## 关键路径与标识\n- ${fittedPaths.join(" | ")}` : "";
  const goalBudget = goalItems.length ? Math.floor(bodyBudget * 0.22) : 0;
  const blockerBudget = blockerItems.length ? Math.floor(bodyBudget * 0.22) : 0;
  const goalSec = fitSection("## 目标与要求", goalItems, goalBudget);
  const blockerSec = fitSection("## 阻塞与错误", blockerItems, blockerBudget);
  const used =
    (goalSec ? goalSec.length + 1 : 0) +
    (blockerSec ? blockerSec.length + 1 : 0) +
    (cappedPathLine ? cappedPathLine.length + 1 : 0);
  const progressSec = fitSection("## 进展与结论", progressItems, Math.max(0, bodyBudget - used));

  const assembled = [goalSec, progressSec, blockerSec, cappedPathLine, refs].filter(Boolean).join("\n");
  if (assembled.length > 0 && assembled.length <= input.maxChars) return assembled;

  // Fallback for very small maxChars budgets (e.g. tiny test limits)
  const flat = dedupeRecent([...goalItems, ...progressItems, ...blockerItems], 40).join("\n");
  return [safeTail(flat, bodyBudget), refs].filter(Boolean).join("\n");
}

/**
 * Default summariser: no model, fully deterministic. Uses structured semantic grouping for repeated compactions
 * (and noise-filtered compaction on the first pass), keeping complete references and staying strictly within `maxChars`.
 */
export function truncatingSummary(input: SummaryInput): string {
  return structuredSummary(input);
}
