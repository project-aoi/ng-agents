import { BUILTIN_SKILLS } from "@ng/presets";
import { asClarifyCard, isEnvelopeOfType, type ActionRecord, type ApprovalRecord, type Effort, type ReferenceLink } from "@ng/protocol";
import type { EngageDetailDTO, EngageItemDTO, EngageListDTO, ReferenceDTO } from "../../shared/api";
import { actionKey, cardBackedActions, humanItemForAction, linkedApprovalId, projectOfAction, readActions, readProjects, type DeskKernel, type Located, type ProjectionInput } from "./common";
import { artifactDTO, button, channelLabelOfAddress, effortLabel, enc, post, sourceInfo } from "./format";

const EFFORTS: readonly Effort[] = ["15m", "45m", "low_energy"];
/** The agents' own playbooks (seeded at boot): not something the owner works with, so not in their context pack. */
const AGENT_PLAYBOOKS: ReadonlySet<string> = new Set(BUILTIN_SKILLS.map((s) => s.name));

export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

export function focusText(on: boolean, buffered: number): string {
  if (!on) return buffered > 0 ? `有 ${buffered} 条暂存通知待查看` : "免打扰未开启";
  return `免打扰已开启：已暂存 ${buffered} 条非紧急外部通知`;
}

/**
 * Open 🔵 actions the owner can work on now: their project (if any) is active, their task was not cancelled, and they
 * are not just "decide the card in Clarify" (cardBackedActions).
 */
export function openHumanActions(kernel: DeskKernel): Array<Located<ActionRecord> & { projectId: string | null; projectTitle: string | null }> {
  const projects = readProjects(kernel);
  const byCell = new Map(projects.map((p) => [p.cellId, p.record]));
  const projectCells = new Set(byCell.keys());
  const out: Array<Located<ActionRecord> & { projectId: string | null; projectTitle: string | null }> = [];
  const actions = readActions(kernel).filter((a) => a.record.owner === "human" && a.record.status === "open");
  const onCard = cardBackedActions(kernel, actions);
  for (const a of actions) {
    if (onCard.has(actionKey(a))) continue;
    const cell = kernel.getCell(a.cellId);
    if (cell?.status === "closed" && cell.closeReason === "cancelled") continue;
    const projectId = projectOfAction(kernel, a, projectCells);
    const project = projectId ? byCell.get(projectId) : undefined;
    if (project && project.lifecycle !== "active") continue;
    out.push({ ...a, projectId: project ? projectId : null, projectTitle: project?.title ?? null });
  }
  return out;
}

function sendInfo(rec: ApprovalRecord | undefined): EngageItemDTO["send"] {
  if (!rec || rec.action.type !== "channel.send" || (rec.status !== "pending" && rec.status !== "failed")) return null;
  const card = asClarifyCard(rec.card.data);
  const targetLabel = card?.cardType === "response" ? card.reply.targetLabel : rec.action.target;
  return { targetLabel, channelLabel: channelLabelOfAddress(rec.action.target), state: rec.status === "failed" ? "send_failed" : "ready" };
}

export function engageItem(input: ProjectionInput, a: Located<ActionRecord> & { projectId: string | null; projectTitle: string | null }): EngageItemDTO {
  const { kernel, now } = input;
  const r = a.record;
  const art = r.artifactId ? kernel.context.getArtifactSync(r.artifactId) : null;
  const linked = linkedApprovalId(r);
  const linkedRec = linked ? kernel.gate.getApprovalSync(linked) : undefined;
  const send = sendInfo(linkedRec);
  const revision = linkedRec?.itemRevision ?? humanItemForAction(kernel,a.cellId,r.id)?.itemRevision;
  const base = `/api/engage/${enc(a.cellId)}/${enc(r.id)}`;
  const deep = art !== null;
  const buttons = [];
  if (send && art && linkedRec) {
    buttons.push(
      button({
        id: "send",
        label: send.state === "send_failed" ? "↻ 重新发送定稿" : `✓ 定稿发送给 ${send.targetLabel}`,
        primary: true,
        endpoint: post(`${base}/send`, { seenVersion: art.version, seenItemRevision: linkedRec.itemRevision }),
      }),
    );
  }
  if (deep) buttons.push(button({ id: "open", label: "打开工作区", primary: !send, client: "open_editor" }));
  buttons.push(button({ id: "done", label: "✓ 已办完", primary: !deep, endpoint: post(`${base}/done`, revision !== undefined ? { seenItemRevision: revision, ...(art ? {seenVersion:art.version} : {}) } : undefined) }));
  return {
    cellId: a.cellId,
    actionId: r.id,
    ...(revision !== undefined ? { itemRevision: revision } : {}),
    title: r.title,
    nextStep: r.nextStep ?? null,
    effort: isEffort(r.effort) ? r.effort : null,
    effortLabel: effortLabel(isEffort(r.effort) ? r.effort : null),
    dueAt: r.dueAt ?? null,
    overdue: typeof r.dueAt === "number" && r.dueAt < now,
    project: a.projectId && a.projectTitle !== null ? { id: a.projectId, title: a.projectTitle } : null,
    source: sourceInfo(r.source),
    kind: deep ? "deep" : "quick",
    artifact: art ? { artifactId: art.artifactId, version: art.version, ...(art.content.title !== undefined ? { title: art.content.title } : {}), updatedBy: art.updatedBy } : null,
    send,
    createdAt: r.createdAt,
    buttons,
  };
}

export function projectEngage(input: ProjectionInput, filter: Effort | "all" = "all"): EngageListDTO {
  const { kernel } = input;
  const all = openHumanActions(kernel);
  const counts: Record<Effort | "all", number> = { all: all.length, "15m": 0, "45m": 0, low_energy: 0 };
  for (const a of all) if (isEffort(a.record.effort)) counts[a.record.effort]++;
  const shown = filter === "all" ? all : all.filter((a) => a.record.effort === filter);
  const items = shown.map((a) => engageItem(input, a));
  items.sort(
    (x, y) =>
      Number(y.overdue) - Number(x.overdue) ||
      (x.dueAt ?? Number.POSITIVE_INFINITY) - (y.dueAt ?? Number.POSITIVE_INFINITY) ||
      x.createdAt - y.createdAt ||
      x.actionId.localeCompare(y.actionId),
  );
  const on = kernel.hub.isFocusSync();
  const buffered = kernel.hub.bufferedCountSync();
  return { generatedAt: input.now, filter, counts, items, focus: { on, buffered, text: focusText(on, buffered) } };
}

function refs(list: readonly ReferenceLink[] | undefined): ReferenceDTO[] {
  return (list ?? []).filter((r) => r && typeof r.label === "string" && typeof r.uri === "string").map((r) => ({ label: r.label, uri: r.uri, ...(r.detail ? { detail: r.detail } : {}) }));
}

/** The original message an item came from, looked up by its envelope id. */
function rawInputOf(kernel: DeskKernel, envelopeId: string | undefined): string | null {
  if (!envelopeId) return null;
  const [m] = kernel.inbox.listMessagesSync({ envelopeId, limit: 1 });
  if (!m) return null;
  const env = isEnvelopeOfType(m.envelope, "handback") ? m.envelope.payload.original : m.envelope;
  if (isEnvelopeOfType(env, "user.message")) return env.payload.text;
  if (isEnvelopeOfType(env, "source.hit")) return env.payload.rawInput ?? env.payload.summary;
  return null;
}

export function projectEngageDetail(input: ProjectionInput, cellId: string, actionId: string): EngageDetailDTO | null {
  const { kernel, now } = input;
  const found = openHumanActions(kernel).find((a) => a.cellId === cellId && a.record.id === actionId);
  if (!found) return null;
  const r = found.record;
  const linked = linkedApprovalId(r);
  const card = linked ? asClarifyCard(kernel.gate.getApprovalSync(linked)?.card.data) : null;
  const seen = new Set<string>();
  const references = [...refs(r.references), ...refs(card?.prep.checked)].filter((x) => (seen.has(x.uri) ? false : (seen.add(x.uri), true)));
  const source = sourceInfo(r.source) ?? sourceInfo(card?.source);
  const raw = card?.rawInput.text ?? rawInputOf(kernel, r.source?.envelopeId);
  return {
    generatedAt: now,
    item: engageItem(input, found),
    artifact: r.artifactId ? artifactDTO(kernel, r.artifactId, now) : null,
    contextPack: {
      references,
      skills: kernel.context
        .listSkillsSync(cellId)
        .filter((s) => !AGENT_PLAYBOOKS.has(s.name))
        .map((s) => ({ name: s.name, description: s.description })),
      rawInput: raw && source ? { text: raw, source } : null,
      prepSummary: card?.prep.summary || null,
    },
  };
}
