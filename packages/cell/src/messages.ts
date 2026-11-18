import {
  createEnvelope,
  inboxAddr,
  PAYLOAD,
  withTx,
  type CellMessageDraft,
  type CellMessagePayload,
  type Envelope,
  type SendToCellResult,
} from "@ng/protocol";
import type { KernelCore } from "./core";

/**
 * One cell (or the control plane) talking to another (docs/05 guard 1 "已关明拒"). The target's state is read and the
 * message enqueued in one transaction, so the answer is exact: `delivered` means it is in a live cell's queue (a
 * one-shot worker that has not settled yet will take it before it closes — its settle transaction counts pending
 * wake-ups after this one committed), `closed` means nothing was stored and the caller should dispatch a successor.
 */
export function sendCellMessage(
  core: Pick<KernelCore, "db" | "cells" | "inbox" | "clock">,
  o: { from: Envelope["from"]; principalId: string; sender: string; toCellId: string; id: string; message: CellMessageDraft },
): SendToCellResult {
  return withTx(core.db, () => {
    const target = core.cells.get(o.toCellId);
    if (!target) return { status: "not_found" };
    if (target.status === "closed") return { status: "closed", closeReason: target.closeReason };
    const payload: CellMessagePayload = {
      fromCellId: o.sender,
      text: o.message.text,
      ...(o.message.summary ? { summary: o.message.summary } : {}),
      ...(o.message.data !== undefined ? { data: o.message.data } : {}),
    };
    const envelope = createEnvelope<CellMessagePayload>(
      {
        id: o.id,
        from: o.from,
        to: inboxAddr(target.id),
        principalId: o.principalId,
        kind: "event",
        type: PAYLOAD.cellMessage,
        payload,
        expectedEpoch: target.epoch,
        ...(o.message.threads?.length ? { threads: o.message.threads } : {}),
      },
      core.clock,
    );
    core.inbox.enqueueSync(target.id, envelope);
    return { status: "delivered", envelopeId: envelope.id, targetStatus: target.status };
  });
}
