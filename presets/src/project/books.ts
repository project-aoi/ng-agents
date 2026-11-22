import {
  CELL_STATUS_KEY,
  gtdKeys,
  isEnvelopeOfType,
  newId, sha256Hex,
  PAYLOAD,
  type ActionRecord,
  type CellResultPayload,
  type ChildSummary,
  type Clock,
  type Envelope,
  type PrepareRunInput,
  type ProjectRecord,
  type RunPorts,
  type WaitingSet,
} from "@ng/protocol";
import { ROLES } from "../shared/config";
import { newAction, newProject, patchAction, statusLine } from "../shared/records";
import type { PlannedAction, ProjectTaskInput } from "./launch";

// A project's books: the records that follow mechanically from what woke it, kept before the model runs (and whatever
// engine runs it) so they never depend on a model calling a tool. They never consume the batch — the project always
// decides what happens next.

export async function readProject(ports: RunPorts): Promise<ProjectRecord | null> {
  return ports.context.readState<ProjectRecord>(ports.self.cellId, gtdKeys.project);
}

export async function readActions(ports: RunPorts): Promise<ActionRecord[]> {
  return ports.actionBooks!.list();
}

const WAITING_PRESETS = new Set(["checker", "sensor"]);

export function waitingFor(description: string, parties: WaitingSet["parties"] = [], extra: Partial<WaitingSet> = {}): WaitingSet {
  return { description, parties, join: "all", ...extra };
}

function seedActions(self: string, planned: readonly PlannedAction[], clock: Clock): ActionRecord[] {
  const now = clock.now();
  return planned
    .filter((p) => p && typeof p.title === "string" && p.title.trim())
    .map((p, index) =>
      newAction(
        {
          id: `act_${sha256Hex(self).slice(0, 24)}_${String(index).padStart(8, "0")}`,
          title: p.title,
          owner: p.owner === "human" || p.owner === "waiting" ? p.owner : "agent",
          projectCellId: self,
          ...(p.owner === "human" ? { nextStep: p.nextStep ?? p.title } : p.nextStep ? { nextStep: p.nextStep } : {}),
          ...(p.owner === "waiting" ? { waiting: waitingFor(p.title) } : {}),
          ...(p.phase ? { phase: p.phase } : {}),
          ...(p.effort ? { effort: p.effort } : {}),
        },
        now,
      ),
    );
}

/** The first Run of a project started with a seed: its record and planned actions. */
function seed(batch: readonly Envelope[], self: string, clock: Clock): { project: ProjectRecord; actions: ActionRecord[] } | null {
  const now = clock.now();
  const task = batch.find((e) => e.type === PAYLOAD.cellTask);
  const input = (task?.payload as { input?: Partial<ProjectTaskInput> } | undefined)?.input;
  const s = input?.project;
  if (!s || typeof s.title !== "string") return null;
  const project = newProject(
    {
      title: s.title,
      ...(s.outcome ? { outcome: s.outcome } : {}),
      ...(s.source ? { source: s.source } : {}),
      ...(s.proposal ? { proposal: s.proposal } : {}),
    },
    now,
  );
  return { project, actions: seedActions(self, Array.isArray(input.actions) ? input.actions : [], clock) };
}

const isKernelNotice = (env: Envelope) => env.type.startsWith("kernel.");

/**
 * PresetDef.prepareRun of the `project` preset. Idempotent (a retried batch runs it again): every step looks at the
 * records as they are now and changes only what is still out of step.
 *
 * 1. First Run: the record and the planned actions from the task's seed.
 * 2. A child's `cell.result`: the action it carried is done (completed); otherwise it stays open — still with a
 *    dormant worker, which can be told what to change, or without a cell when the child is gone (the model
 *    re-dispatches or re-plans). A later turn of a worker whose action is already closed changes nothing here.
 * 4. Every open direct child is on the books: one started with plain spawn_cell (no action names it) gets an action too.
 * 5. A parked or finished record whose cell was woken by something real (resumed, or a follow-up beat the close) is
 *    active again.
 */
export async function prepareProjectRun({ snapshot, ports, clock }: PrepareRunInput): Promise<void> {
  if (ports.self.spec.meta?.["role"] !== ROLES.project) return;
  const self = ports.self.cellId;
  const now = clock.now();
  const batch = snapshot.batch.envelopes;
  const patches: Record<string, unknown> = {};
  let project = await readProject(ports);
  const actions = new Map((await readActions(ports)).map((a) => [a.id, a]));
  const updates = new Map<string, ActionRecord>();
  const set = (a: ActionRecord) => {
    actions.set(a.id, a);
    updates.set(a.id, a);
  };

  // The task message carries the seed. The record may already be there (a project parked straight from a proposal has
  // its record written by the app before its first Run); the planned actions are still seeded, once — the brief tells
  // the project they are on its books.
  const seeded = batch.some((e) => e.type === PAYLOAD.cellTask) ? seed(batch, self, clock) : null;
  if (seeded) {
    if (!project) {
      project = seeded.project;
      patches[gtdKeys.project] = project;
      patches[CELL_STATUS_KEY] = statusLine(project.outcome ? `目标：${project.outcome}` : project.title, now);
    }
    for (const a of seeded.actions) if (!actions.has(a.id)) set(a);
  }

  const carrying = (cellId: string) => [...actions.values()].find((a) => a.status === "open" && a.cellId === cellId);
  for (const env of batch) {
    if (isEnvelopeOfType(env, "cell.result")) {
      const p = env.payload as CellResultPayload;
      const a = carrying(p.childCellId);
      if (!a) continue;
      if (p.status === "completed") {
        set(patchAction(a, { status: "done", ...(p.artifactId ? { artifactId: p.artifactId } : {}) }, now));
      } else if (p.childState !== "dormant") {
        set(patchAction(a, { cellId: null }, now));
      }

    }
  }

  const children = snapshot.tail.roster.filter((c: ChildSummary) => c.parentId === self && c.status !== "closed");
  for (const c of children) {
    // Any record of it counts: an action the model closed itself while the child still runs stays closed.
    if ([...actions.values()].some((a) => a.cellId === c.cellId)) continue;
    const owner = c.preset && WAITING_PRESETS.has(c.preset) ? "waiting" : "agent";
    const title = c.title ?? c.cellId;
    set(
      newAction(
        { id: newId("act", clock), title, owner, projectCellId: self, cellId: c.cellId, ...(owner === "waiting" ? { waiting: waitingFor(title) } : {}) },
        now,
      ),
    );
  }

  if (project && project.lifecycle !== "active" && batch.some((e) => !isKernelNotice(e))) {
    const { completedAt: _done, ...rest } = project;
    project = { ...rest, lifecycle: "active", updatedAt: now };
    patches[gtdKeys.project] = project;
  }

  if (updates.size || Object.keys(patches).length) ports.actionBooks!.commit([...updates.values()], patches);
}
