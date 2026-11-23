import type { Kernel } from "@ng/cell";
import {
  isNgError,
  newId,
  sha256Hex,
  type BallOwner,
  type CellSpec,
  type Clock,
  type Effort,
  type ItemSource,
  type ProjectProposal,
  type RunnerOverride,
} from "@ng/protocol";
import { ROLES } from "../shared/config";
import { PROJECT_PROCESSOR } from "../shared/processors";

// One builder for every way a project starts — the desk's start_project, an approved proposal (desk books and the
// app's synchronous confirm), and the control plane — so the project cell and its first task can never drift apart.

export interface RepoRef {
  name: string;
  cwd: string;
  defaultBranch?: string;
}

export interface PlannedAction {
  title: string;
  owner: BallOwner;
  nextStep?: string;
  phase?: number;
  effort?: Effort;
}

export type ProjectMode = "now" | "research_then_park";

/** Everything a project starts from. */
export interface ProjectInit {
  title: string;
  /** What done looks like. */
  outcome: string;
  /** The request in full: what the owner wants, constraints, links (rendered into the project's first message). */
  brief: string;
  /** The project's directory on this machine (absolute; the kernel refuses one that does not exist). */
  cwd?: string;
  repos?: RepoRef[];
  /** "research_then_park": research what the thing should be, save a report, then park as someday. Default "now". */
  mode?: ProjectMode;
  /** Staged work: the phases in order (one at a time, each after the owner's go-ahead). */
  phases?: string[];
  /** Planned actions, recorded on the project's first run. */
  plan?: PlannedAction[];
  /** Where the item came from (Radar's source bar). Default: { label: "立项" }. */
  source?: ItemSource;
  /** The approved plan this project starts from, kept on its record. Default: built from `plan` when there is one. */
  proposal?: ProjectProposal;
  /** Fixed project cell id (makes the start idempotent). Default: a new `proj_…` id. */
  id?: string;
  /** The message that triggered the start (possibly the last of several); quoted in the brief unless the brief already contains it. */
  rawInput?: string;
  /** Continue from the starting cell's conversation (fork_prefix). */
  continueConversation?: boolean;
  runnerOverride?: RunnerOverride;
}

/** `gtd:project` as the project's first run writes it. */
export interface ProjectSeed {
  title: string;
  outcome: string;
  source: ItemSource;
  proposal?: ProjectProposal;
}

/** `cell.task.input` of a project cell (read by its books on the first run). */
export interface ProjectTaskInput {
  project: ProjectSeed;
  actions?: PlannedAction[];
  phases?: string[];
  mode: ProjectMode;
  repos?: RepoRef[];
}

export interface ProjectLaunch {
  projectId: string;
  spec: CellSpec;
  task: { title: string; instruction: string; input: ProjectTaskInput };
}

function proposalOf(init: ProjectInit): ProjectProposal | undefined {
  if (init.proposal) return init.proposal;
  if (!init.plan?.length) return undefined;
  return {
    title: init.title,
    outcome: init.outcome,
    background: init.brief,
    actions: init.plan.map((a) => ({ title: a.title, owner: a.owner, ...(a.effort ? { effort: a.effort } : {}), ...(a.nextStep ? { nextStep: a.nextStep } : {}) })),
  };
}

const OWNER_TEXT: Readonly<Record<BallOwner, string>> = { agent: "交给 worker", human: "主人来做", waiting: "等外部" };

/** Deterministic action id assigned to the i-th valid planned action seeded on a project's first Run. */
export function seededActionId(projectId: string, index: number): string {
  return `act_${sha256Hex(projectId).slice(0, 24)}_${String(index).padStart(8, "0")}`;
}

/** The project's first message, in Chinese: everything it needs, nothing implicit. */
export function renderBrief(init: ProjectInit, projectId?: string): string {
  const out: string[] = [];
  const section = (title: string, ...lines: string[]) => out.push(`## ${title}`, ...lines, "");
  // The message that triggered the start may be only the last of several: quoted as what it is, and only when the
  // brief does not already carry it.
  const raw = init.rawInput?.trim();
  section("主人的要求", ...(raw && !init.brief.includes(raw) ? [`触发这次立项的消息（可能只是几条消息中的最后一条）：${raw}`] : []), init.brief.trim());
  section("目标（做到什么算完成）", init.outcome.trim());
  section(
    "工作目录",
    init.cwd ? `${init.cwd}（这是本项目的目录；要换目录先问主人）` : "未指定。需要读写代码时，先问主人仓库在本机的绝对路径，绝不要猜。",
  );
  if (init.repos?.length) {
    section("涉及的仓库", ...init.repos.map((r) => `- ${r.name}：${r.cwd}${r.defaultBranch ? `（默认分支 ${r.defaultBranch}）` : ""}`));
  }
  if ((init.mode ?? "now") === "research_then_park") {
    section(
      "推进方式：先调研，再停靠",
      "这是主人先记下来的想法，现在不做实现。派一个只读 worker 调研这件事应该做成什么样（可以参考其他产品的做法），把结论存成调研报告（artifact）。",
      '报告完成后：用 update_project 写一句结论，然后 finish_project（outcome "someday"）停靠到“以后再说”。主人以后重新提起时会唤醒你。',
    );
  } else {
    section("推进方式", "现在开始推进：你负责计划、记录和汇总，读代码、改代码、跑测试、调研这些重活交给 worker（dispatch）。worker 一轮做完会待命，同一件事的后续直接发消息给它（send_message）。");
  }
  if (init.phases?.length) {
    section(
      "分阶段",
      ...init.phases.map((p, i) => `${i + 1}. ${p}`),
      "一次只推进一个阶段：当前阶段完成后，用 request_approval 请主人确认，得到同意再开始下一阶段。由主人自己完成的阶段不用另请确认：主人勾掉那一步就是同意。",
    );
  }
  const planned = (init.plan ?? []).filter((a) => a && typeof a.title === "string" && a.title.trim());
  if (planned.length) {
    section(
      "初步计划（已记在你的行动记录里；派工或更新时请直接传对应的 actionId）",
      ...planned.map((a, i) => `- [${OWNER_TEXT[a.owner]}]${projectId ? ` (${seededActionId(projectId, i)})` : ""} ${a.title}${a.phase ? `（阶段 ${a.phase}）` : ""}${a.nextStep ? `：${a.nextStep}` : ""}`),
    );
  }
  return out.join("\n").trimEnd();
}

/** The project cell's spec and first task. */
export function projectLaunch(init: ProjectInit, clock: Clock): ProjectLaunch {
  const projectId = init.id ?? newId("proj", clock);
  const spec: CellSpec = {
    id: projectId,
    preset: "project",
    title: init.title,
    processor: { ...PROJECT_PROCESSOR, ...(init.runnerOverride ?? init.proposal?.runnerOverride) },
    meta: { role: ROLES.project, projectCellId: projectId },
  };
  if (init.cwd) spec.cwd = init.cwd;
  if (init.continueConversation) spec.contextMode = "fork_prefix";
  const proposal = proposalOf(init);
  const project: ProjectSeed = {
    title: init.title,
    outcome: init.outcome,
    source: init.source ?? { label: "立项", at: clock.now() },
    ...(proposal ? { proposal } : {}),
  };
  const input: ProjectTaskInput = {
    project,
    mode: init.mode ?? "now",
    ...(init.plan?.length ? { actions: init.plan } : {}),
    ...(init.phases?.length ? { phases: init.phases } : {}),
    ...(init.repos?.length ? { repos: init.repos } : {}),
  };
  return { projectId, spec, task: { title: init.title, instruction: renderBrief(init, projectId), input } };
}

/**
 * For the app's control plane (and an approved proposal): start a project exactly as the desk's start_project does,
 * in the caller's transaction. Spawned under `opts.parentId` (default the desk) as the explicitly supplied principal. Idempotent on `init.id`: an existing cell gives
 * `started: false`. A kernel refusal (e.g. `cwd` is not an existing directory) propagates as the NgError it is.
 */
export function startProjectSync(
  kernel: Pick<Kernel, "spawnCell" | "clock" | "deskCellId">,
  init: ProjectInit,
  opts: { principalId: string; parentId?: string },
): { projectId: string; started: boolean } {
  const launch = projectLaunch(init, kernel.clock);
  try {
    kernel.spawnCell(opts.parentId ?? kernel.deskCellId, launch.spec, launch.task, { principalId: opts.principalId });
    return { projectId: launch.projectId, started: true };
  } catch (err) {
    if (isNgError(err, "duplicate")) return { projectId: launch.projectId, started: false };
    throw err;
  }
}
