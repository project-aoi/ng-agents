import type { Envelope, EvidenceEntry, ModelMessage, PromptSnapshot, RunPorts } from "@ng/protocol";
import { freshPrompt, tailText } from "./render";

export interface AppendedInput {
  envelopeId: string;
  kind: "steer" | "inbound";
  text: string;
  status: "queued" | "sent" | "confirmed";
  sentInLeg?: number;
  /** Exact turn number of the non-stopped, succeeding `turn_end` before this item counts as confirmed. */
  confirmAtTurn?: number;
}

export function renderEvidenceInbound(env: Envelope): string {
  const p = env.payload as { text?: unknown; message?: unknown } | null;
  if (p && typeof p.text === "string") return `[${env.type} from ${env.from}] ${p.text}`;
  if (p && typeof p.message === "string") return `[${env.type} from ${env.from}] ${p.message}`;
  return `[${env.type} from ${env.from}] ${JSON.stringify(env.payload)}`;
}

/** Convert SQLite evidence entries from earlier legs of this Run into provider-neutral messages for a fresh rebuild. */
function evidenceToMessages(
  entries: readonly EvidenceEntry[],
  unconfirmedIds: ReadonlySet<string>,
  steerSeqToEnvelopeId: ReadonlyMap<number, string>,
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
        const envId = steerSeqToEnvelopeId.get(entry.seq);
        if (envId && unconfirmedIds.has(envId)) break;
        if (envId) coveredInEarlier.add(envId);
        out.push({ role: "user", content: [{ type: "text", text: r.text }] });
        break;
      }
      case "external":
        out.push({
          role: "user",
          content: [{ type: "text", text: r.title ? `[${r.source}: ${r.title}]\n${r.text}` : `[${r.source}]\n${r.text}` }],
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
  steerIds: ReadonlyMap<number, string>,
  unconfirmed: readonly AppendedInput[],
): string {
  const entries = (ports.listEvidence?.({ afterSeq: snapshot.historyUptoSeq }) ?? []).filter((e) => e.record.runId === snapshot.runId);
  const progressed = entries.some(({ record }) => ["assistant_text", "tool_call", "tool_result"].includes(record.kind));
  const emitted = new Set<string>();
  const pendingIds = new Set(unconfirmed.map((i) => i.envelopeId));
  const earlier = progressed ? evidenceToMessages(entries, pendingIds, steerIds, tracked, emitted) : [];
  const parts: string[] = [];
  if (!progressed || [...initialBatchIds].some((id) => !emitted.has(id) && !pendingIds.has(id))) {
    const tail = tailText(snapshot);
    if (tail.trim()) {
      if (progressed) earlier.unshift({ role: "user", content: [{ type: "text", text: tail }] });
      else parts.push(tail);
      for (const id of initialBatchIds) emitted.add(id);
    }
  }
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
