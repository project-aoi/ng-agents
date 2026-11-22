import type { Envelope, EvidenceEntry, EvidenceOf, ModelMessage, PromptSnapshot, RunPorts } from "@ng/protocol";
import { messageText } from "@ng/protocol";
import { freshPrompt } from "./render";

export interface AppendedInput {
  envelopeId: string;
  kind: "steer" | "inbound";
  text: string;
  status: "queued" | "sent" | "confirmed";
  sentInLeg?: number;
  evidenceRecorded?: boolean;
  /** Turn that must process this input before the claim can complete. */
  confirmAtTurn?: number;
}

export function renderEvidenceInbound(env: Envelope): string {
  const p = env.payload as { text?: unknown; message?: unknown } | null;
  if (p && typeof p.text === "string") return `[${env.type} from ${env.from}] ${p.text}`;
  if (p && typeof p.message === "string") return `[${env.type} from ${env.from}] ${p.message}`;
  return `[${env.type} from ${env.from}] ${JSON.stringify(env.payload)}`;
}

export function renderEvidenceExternal(record: EvidenceOf<"external">): string {
  const header = [record.source, record.title, record.uri].filter(Boolean).join(" · ");
  return `[${header}]\n${record.text}`;
}

/** Convert SQLite evidence entries from earlier legs of this Run into provider-neutral messages for a fresh rebuild. */
function evidenceToMessages(
  entries: readonly EvidenceEntry[],
  unconfirmedIds: ReadonlySet<string>,
  tracked: ReadonlyMap<string, AppendedInput>,
  coveredInEarlier: Set<string>,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const entry of entries) {
    const r = entry.record;
    switch (r.kind) {
      case "run_boundary":
        break;
      case "inbound": {
        if (unconfirmedIds.has(r.envelope.id)) break;
        coveredInEarlier.add(r.envelope.id);
        const text = tracked.get(r.envelope.id)?.text ?? renderEvidenceInbound(r.envelope);
        out.push({ role: "user", content: [{ type: "text", text }] });
        break;
      }
      case "system_note": {
        const envId = r.envelopeId;
        if (envId && unconfirmedIds.has(envId)) break;
        if (envId) coveredInEarlier.add(envId);
        out.push({ role: "user", content: [{ type: "text", text: r.text }] });
        break;
      }
      case "external":
        out.push({
          role: "user",
          content: [{ type: "text", text: renderEvidenceExternal(r) }],
        });
        break;
      case "assistant_text":
        out.push({ role: "assistant", content: [{ type: "text", text: r.text }] });
        break;
      case "tool_call":
        out.push({ role: "assistant", content: [{ type: "tool_use", id: r.toolUseId, name: r.name, input: r.input }] });
        break;
      case "tool_result":
        out.push({
          role: "user",
          content: [{ type: "tool_result", toolUseId: r.toolUseId, content: r.output, ...(r.isError ? { isError: true } : {}) }],
        });
        break;
    }
  }
  return out;
}

/** Rebuild a lost session from answered turns and pending inputs. Deduplicate by identity so identical messages survive. */
export function rebuildFreshPrompt(
  snapshot: PromptSnapshot,
  initialBatchIds: ReadonlySet<string>,
  ports: RunPorts,
  tracked: ReadonlyMap<string, AppendedInput>,
  unconfirmed: readonly AppendedInput[],
): string {
  const entries = (ports.listEvidence?.({ afterSeq: snapshot.historyUptoSeq }) ?? []).filter((e) => e.record.runId === snapshot.runId);
  const progressed = entries.some(({ record }) => ["assistant_text", "tool_call", "tool_result"].includes(record.kind));
  const emitted = new Set<string>();
  const pendingIds = new Set(unconfirmed.map((i) => i.envelopeId));
  const earlier = progressed ? evidenceToMessages(entries, pendingIds, tracked, emitted) : [];
  const parts: string[] = [];
  const initial = snapshot.batch.envelopes.filter(env => initialBatchIds.has(env.id));
  const batchEnd = snapshot.tail.messages.length - initial.length;
  const opening = snapshot.tail.messages.slice(0, Math.max(0, batchEnd));
  initial.forEach((env, index) => {
    if (emitted.has(env.id) || pendingIds.has(env.id)) return;
    const message = snapshot.tail.messages[batchEnd + index];
    opening.push(message ?? { role: "user", content: [{ type: "text", text: renderEvidenceInbound(env) }] });
    emitted.add(env.id);
  });
  if (progressed) earlier.unshift(...opening);
  else parts.push(...opening.map(messageText));
  const include = (id: string, text: string) => {
    if (!emitted.has(id) && text.trim()) parts.push(text);
    emitted.add(id);
  };
  for (const { record } of entries) {
    if (record.kind === "inbound") include(record.envelope.id, tracked.get(record.envelope.id)?.text ?? renderEvidenceInbound(record.envelope));
  }
  for (const item of unconfirmed) include(item.envelopeId, item.text);
  if (progressed && !parts.length) parts.push("[Continue from the earlier work above and complete the task.]");
  return freshPrompt([...snapshot.history, ...earlier], parts.join("\n\n"));
}
