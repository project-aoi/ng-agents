import { NgError } from "./errors";
import type { ProposedAction } from "./contract/gate";

export type CardEffect = "reply" | "revise" | "execute" | "defer" | "terminate" | "complete";
export type HumanItemStatus = "pending" | "snoozed" | "resolved" | "cancelled";

export interface CardOption {
  id: string;
  label: string;
  effect: CardEffect;
  primary?: boolean;
  group?: "main" | "more";
  hint?: string;
  input?: { mode: "none" | "optional" | "required"; placeholder?: string };
  payload?: Record<string, unknown>;
  terminateMode?: "deny" | "cancel_task";
  targetCellIds?: string[];
  confirm?: string;
}

export interface HumanItemDraft {
  subjectKey: string;
  title: string;
  description?: string;
  prep?: import("./gtd").CardPrep;
  source?: import("./gtd").ItemSource;
  rawInput?: import("./gtd").DecisionCard["rawInput"];
  relatedProjectIds?: string[];
  options: CardOption[];
  category?: "action" | "decision";
  dueAt?: number;
  effort?: string;
  /** A versioned draft the card is about: the card is bound to the version current when it is raised, and a decision must name the version the owner saw. */
  artifactId?: string;
}

export interface HumanItem extends Omit<HumanItemDraft, "artifactId"> {
  category: "action" | "decision";
  id: string;
  cellId: string | null;
  epoch: number | null;
  status: HumanItemStatus;
  itemRevision: number;
  /** When it was first raised (later changes to it do not move this). */
  createdAt: number;
  relatedProjectIds: string[];
  snoozedUntil: number | null;
  artifactId: string | null;
  artifactVersion: number | null;
  humanEdited: boolean;
  action: ProposedAction | null;
}

export interface HumanDecision {
  optionId: string;
  seenItemRevision: number;
  seenArtifactVersion?: number;
  note?: string;
  until?: number;
  confirmedTargets?: string[];
  confirmedClosure?: string[];
  resumeProjectId?: string;
}

const effects: readonly CardEffect[] = ["reply", "revise", "execute", "defer", "terminate", "complete"];
export function checkCardOptions(options: CardOption[], opts: { callback: boolean; controlled: boolean }): void {
  const invalid = (why: string): never => {
    throw new NgError("invalid_argument", why);
  };
  if (!Array.isArray(options)) invalid("options must be an array");
  const main = options.filter((o) => o && o.group !== "more");
  if (main.length < 1 || main.length > 4 || options.filter((o) => o?.primary).length > 1)
    invalid("choose 1–4 main options and at most one primary");
  const ids = new Set<string>();
  for (const o of options) {
    if (!o || typeof o.id !== "string" || !o.id.trim() || ids.has(o.id) || o.id.startsWith("system.")) invalid("invalid or duplicate option id");
    ids.add(o.id);
    if (typeof o.label !== "string" || !o.label.trim() || !effects.includes(o.effect))
      invalid("each option needs a label and a supported effect");
    if (o.group && !["main", "more"].includes(o.group)) invalid("invalid option group");
    if (o.input && !["none", "optional", "required"].includes(o.input.mode)) invalid("invalid input mode");
    if (o.effect === "execute" && !opts.controlled) invalid("execute requires a controlled action");
    if (o.effect === "complete" && opts.callback) invalid("complete is only for personal items");
    if (!opts.callback && !["complete", "defer", "terminate"].includes(o.effect)) invalid("this option needs a callback");
    if (o.terminateMode === "cancel_task" && (!opts.callback || o.effect !== "terminate" || o.targetCellIds?.length !== 1))
      invalid("cancel_task requires exactly one target");
    if (o.terminateMode && !["deny", "cancel_task"].includes(o.terminateMode)) invalid("invalid termination mode");
  }
  if (opts.controlled && !options.some((o) => o.effect === "execute")) invalid("the controlled action needs an execute option");
}

/**
 * Every option whose decision goes back to someone (reply, approve/execute, complete) takes the owner's words with
 * it — a condition on an approval belongs on the approval, not in a second message (audit E26).
 */
export function addCardExits(options: CardOption[], callback: boolean): CardOption[] {
  const all = options.map(
    (o): CardOption => (!o.input && (o.effect === "complete" || o.effect === "reply" || o.effect === "execute") ? { ...o, input: { mode: "optional" } } : o),
  );
  if (!all.some((o) => o.effect === "defer")) all.push({ id: "system.defer", label: "推迟", effect: "defer", group: "more" });
  if (!all.some((o) => o.effect === "terminate" && o.terminateMode !== "cancel_task"))
    all.push({
      id: "system.deny",
      label: callback ? "拒绝并告知后台" : "取消提醒",
      effect: "terminate",
      input: { mode: "optional" },
      group: "more",
    });
  return all;
}
