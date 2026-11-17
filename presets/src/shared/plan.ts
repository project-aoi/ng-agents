import type {
  BallOwner,
  CellSpec,
  ChannelAddr,
  Effort,
  Envelope,
  ItemSource,
  PolicyBounds,
  ProcessorSpec,
  ProjectProposal,
  ToolKind,
} from "@ng/protocol";
import { PROCESSORS, PROMPTS, ROLES, STD, TOOLSETS } from "./config";
import type { RawInput } from "./records";

// ==================== processors the presets use (also the presets' defaults) ====================

export const DESK_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.desk,
  modelTier: "strong",
  // The desk delegates: of the workspace tools it sees only `read` (docs/02 铁律 1), never write/edit/bash.
  allowedTools: ["read"],
  toolsets: [TOOLSETS.desk, STD.context, STD.comms, STD.schedule, STD.cells, STD.workspace],
};

export const WORKER_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.worker,
  modelTier: "strong",
  toolsets: [STD.workspace, STD.context, STD.comms, STD.cells],
};

export const WATCHER_CODE_PROCESSOR: ProcessorSpec = { kind: "code", entry: PROCESSORS.waitMatch };

export const WATCHER_LLM_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.watcher,
  modelTier: "fast",
  toolsets: [TOOLSETS.watcher, STD.comms, STD.context],
};

export const SENSOR_LLM_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.sensor,
  modelTier: "fast",
  allowedTools: ["read"],
  toolsets: [TOOLSETS.sensor, STD.context, STD.workspace],
};

export const COORDINATOR_PROCESSOR: ProcessorSpec = { kind: "code", entry: PROCESSORS.joinAll };

export const EDITOR_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.editor,
  modelTier: "strong",
  toolsets: [TOOLSETS.editor, STD.context],
};

// ==================== plans ====================

/** What the item is and where it came from (shown on its card and its project row). */
export interface ItemInfo {
  title: string;
  outcome?: string;
  source: ItemSource;
  rawInput: RawInput;
  /** The inbound envelope, kept so the item can be moved back to Clarify. */
  envelope?: Envelope;
  /** Someone outside who asked: the result card then sends the result back to them ("确认发送"). */
  replyTo?: ChannelAddr;
  replyLabel?: string;
}

export interface PartyPlan {
  id: string;
  label: string;
  /** Where a nudge goes. */
  to?: ChannelAddr;
  /** Watched thread ("<channelId>:<threadId>"): replies there reach the watcher directly. */
  thread?: string;
  /** Only this sender counts as the party's reply (others on the thread go to the desk). */
  principalId?: string;
  dueAt?: number;
}

export interface ChildPlan {
  /** Stable within the root; the child cell id is `${rootId}-${slot}`. */
  slot: string;
  label: string;
  spec: CellSpec;
  payload?: unknown;
  party?: PartyPlan;
}

/** One action of the item (one ActionRecord) and the children that carry it. */
export interface GroupPlan {
  id: string;
  title: string;
  owner: BallOwner;
  /** all: every child must report; any: the first result completes the group (the rest are stopped). */
  join: "all" | "any";
  /** Progress label for Radar, e.g. "正在并发整理竞品资料". */
  label?: string;
  effort?: Effort;
  nextStep?: string;
  waiting?: { description: string; dueAt?: number };
  children: ChildPlan[];
  /** Raise one result card when the group completes (otherwise the action just closes). */
  card: boolean;
}

export interface ItemPlan {
  kind: "single" | "fan_out" | "chase" | "project";
  rootId: string;
  item: ItemInfo;
  groups: GroupPlan[];
}

export const childCellId = (rootId: string, slot: string) => `${rootId}-${slot}`;

/**
 * Tool kinds for a bounds *request* that travels as JSON (inside a root's task payload): a Set would serialize to
 * `{}`, so the request carries an array, which attenuation accepts.
 */
export function toolKinds(...kinds: ToolKind[]): ReadonlySet<ToolKind> {
  return kinds as unknown as ReadonlySet<ToolKind>;
}

// ==================== child specs ====================

export interface WorkerOptions {
  title: string;
  instruction: string;
  input?: unknown;
  /** Research without a repository: no isolated checkout; it may read and report but not change files. */
  research?: boolean;
  repo?: { repoPath?: string; baseRef?: string; branch?: string };
  /** Continue from the desk's conversation (fork_prefix through the root). */
  fork?: boolean;
  /** 1-to-1 direct line: the worker may message the owner and the owner's replies on `thread` reach it directly. */
  directLine?: { ownerAddress: ChannelAddr; thread: string };
}

export function workerChild(rootId: string, slot: string, o: WorkerOptions): ChildPlan {
  const bounds: Partial<PolicyBounds> = o.research ? { isolation: "none", tools: toolKinds("read") } : { isolation: "git_worktree" };
  if (o.directLine) bounds.canSendTo = [o.directLine.ownerAddress];
  const spec: CellSpec = {
    id: childCellId(rootId, slot),
    preset: "worker",
    title: o.title,
    processor: WORKER_PROCESSOR,
    bounds,
    meta: { role: ROLES.worker, ...(o.repo ? { workspace: o.repo } : {}), gtd: { slot } },
  };
  if (o.fork) spec.contextMode = "fork_prefix";
  if (o.directLine) spec.watches = [{ threadOrFilter: { thread: o.directLine.thread } }];
  return { slot, label: o.title, spec, payload: o.input === undefined ? o.instruction : { instruction: o.instruction, input: o.input } };
}

export interface WatcherOptions {
  description: string;
  itemTitle: string;
  /** Interpret replies with a fast model instead of treating any message from the party as the reply. */
  interpret?: boolean;
  nudgeText?: string;
}

export function watcherChild(rootId: string, slot: string, party: PartyPlan, o: WatcherOptions): ChildPlan {
  const spec: CellSpec = {
    id: childCellId(rootId, slot),
    preset: "watcher",
    title: `等待${party.label}回复`,
    processor: o.interpret ? WATCHER_LLM_PROCESSOR : WATCHER_CODE_PROCESSOR,
    bounds: { isolation: "none", tools: toolKinds(), canSendTo: party.to ? [party.to] : [] },
    meta: { role: ROLES.watcher, gtd: { slot, party, description: o.description, itemTitle: o.itemTitle, ...(o.nudgeText ? { nudgeText: o.nudgeText } : {}) } },
  };
  if (party.thread) {
    spec.watches = [{ threadOrFilter: { thread: party.thread, ...(party.principalId ? { principalId: party.principalId } : {}) }, cancelGroup: "reply" }];
  }
  if (party.dueAt !== undefined) spec.schedules = [{ deliverAt: party.dueAt, cancelGroup: "timeout" }];
  return { slot, label: party.label, spec, payload: { instruction: `等待${party.label}回复：${o.description}`, input: { party } }, party };
}

/** The root of an item: a worker-preset cell running the zero-token coordinator, holding gtd:project. */
export function rootSpec(plan: ItemPlan, o: { fork?: boolean } = {}): CellSpec {
  const spec: CellSpec = {
    id: plan.rootId,
    preset: "worker",
    title: plan.item.title,
    processor: COORDINATOR_PROCESSOR,
    // The root never touches a workspace; "none" lets research children stay unisolated, writers ask for a worktree.
    // It may message its own children (commands) and send a result back to whoever asked (after approval).
    bounds: { isolation: "none", canSendTo: ["inbox:*", "channel:*"] as unknown as PolicyBounds["canSendTo"] },
    meta: { role: ROLES.coordinator, projectCellId: plan.rootId, gtd: { kind: plan.kind } },
  };
  if (o.fork) spec.contextMode = "fork_prefix";
  return spec;
}

export function rootTask(plan: ItemPlan): { instruction: string; input: ItemPlan } {
  return { instruction: `coordinate: ${plan.item.title}`, input: plan };
}

// ==================== composites ====================

export function singlePlan(rootId: string, item: ItemInfo, worker: Omit<WorkerOptions, "title"> & { title?: string }): ItemPlan {
  const title = worker.title ?? item.title;
  return {
    kind: "single",
    rootId,
    item,
    groups: [{ id: `${rootId}-a1`, title, owner: "agent", join: "all", children: [workerChild(rootId, "w1", { ...worker, title })], card: true }],
  };
}

export function fanOutPlan(
  rootId: string,
  item: ItemInfo,
  o: { label?: string; instruction: string; items: Array<{ title: string; instruction?: string; input?: unknown }>; research?: boolean; repo?: WorkerOptions["repo"] },
): ItemPlan {
  const children = o.items.map((it, i) =>
    workerChild(rootId, `w${i + 1}`, {
      title: it.title,
      instruction: it.instruction ? `${o.instruction}\n\n${it.instruction}` : o.instruction,
      ...(it.input !== undefined ? { input: it.input } : {}),
      ...(o.research !== undefined ? { research: o.research } : {}),
      ...(o.repo ? { repo: o.repo } : {}),
    }),
  );
  return {
    kind: "fan_out",
    rootId,
    item,
    groups: [{ id: `${rootId}-a1`, title: item.title, owner: "agent", join: "all", label: o.label ?? item.title, children, card: true }],
  };
}

export function chasePlan(
  rootId: string,
  item: ItemInfo,
  o: { description: string; parties: PartyPlan[]; dueAt: number; join?: "all" | "any"; interpret?: boolean; nudgeText?: string },
): ItemPlan {
  const children = o.parties.map((p, i) =>
    watcherChild(rootId, `p${i + 1}`, { ...p, dueAt: p.dueAt ?? o.dueAt }, {
      description: o.description,
      itemTitle: item.title,
      ...(o.interpret ? { interpret: true } : {}),
      ...(o.nudgeText ? { nudgeText: o.nudgeText } : {}),
    }),
  );
  return {
    kind: "chase",
    rootId,
    item,
    groups: [
      {
        id: `${rootId}-a1`,
        title: o.description,
        owner: "waiting",
        join: o.join ?? "all",
        waiting: { description: o.description, dueAt: o.dueAt },
        children,
        card: true,
      },
    ],
  };
}

/** An approved project proposal: agent actions get a worker each; human and waiting actions are recorded for the owner. */
export function projectPlan(
  rootId: string,
  item: ItemInfo,
  proposal: ProjectProposal,
  o: { research?: boolean; repo?: WorkerOptions["repo"] } = {},
): ItemPlan {
  const groups: GroupPlan[] = proposal.actions.map((a, i) => {
    const id = `${rootId}-a${i + 1}`;
    const base = { id, title: a.title, owner: a.owner, join: "all" as const, ...(a.effort ? { effort: a.effort } : {}) };
    if (a.owner === "agent") {
      const instruction = [`项目「${proposal.title}」的一项工作：${a.title}`, a.nextStep ? `下一步：${a.nextStep}` : "", `项目目标：${proposal.outcome}`, proposal.background ? `背景：${proposal.background}` : ""]
        .filter(Boolean)
        .join("\n");
      return {
        ...base,
        children: [workerChild(rootId, `w${i + 1}`, { title: a.title, instruction, ...(o.research !== undefined ? { research: o.research } : {}), ...(o.repo ? { repo: o.repo } : {}) })],
        card: true,
      };
    }
    if (a.owner === "waiting") return { ...base, waiting: { description: a.title }, nextStep: a.nextStep ?? a.title, children: [], card: false };
    return { ...base, nextStep: a.nextStep ?? a.title, children: [], card: false };
  });
  return { kind: "project", rootId, item: { ...item, title: proposal.title, outcome: proposal.outcome }, groups };
}
