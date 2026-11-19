import { gtdKeys, PAYLOAD, type PolicyBounds, type PrepareRunInput, type PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { HUB_PROCESSOR } from "../shared/processors";
import { ensureSource } from "../shared/sensor";

/**
 * A hub is listed with the owner's sources (信源), not as a project: it is a standing entry point for a stream, like a
 * watch source. Its SourceRecord (from spec.meta.gtd.source, written by add_hub) is created on its first run and
 * counts the batches of the stream it routes.
 */
async function hubBooks({ snapshot, ports, clock }: PrepareRunInput): Promise<void> {
  if (ports.self.spec.meta?.["role"] !== ROLES.hub) return;
  const now = clock.now();
  const src = await ensureSource(ports, now);
  if (!snapshot.batch.envelopes.some((e) => e.type === PAYLOAD.userMessage)) return;
  await ports.context.commit(ports.self.cellId, { statePatches: { [gtdKeys.source]: { ...src, runCount: src.runCount + 1, lastRunAt: now, lastHitAt: now, hitCount: src.hitCount + 1, updatedAt: now } } });
}

export function hubPreset(): PresetDef {
  return {
    name: "hub",
    description: "Persistent router for one stream of direct messages: batches what its watch routes, hands each topic to a worker, forwards follow-ups.",
    defaults: { processor: HUB_PROCESSOR, lifetime: "persistent", absorbInbound: true, meta: { role: ROLES.hub } },
    // A reply to the people in the thread is drafted with send_message and waits on the owner's card.
    requestBounds: () => ({ canSendTo: ["channel:*"] as unknown as PolicyBounds["canSendTo"] }),
    prepareRun: (input) => hubBooks(input),
  };
}
