import {
  NgError,
  OWNER_PRINCIPAL,
  afterCommit,
  channelAddr,
  deliverableSchema,
  fromJson,
  inTransaction,
  newId,
  parseAddress,
  run,
  systemClock,
  withTx,
  type ActionTokenVerifier,
  type Bus,
  type Channel,
  type ChannelAddr,
  type ChannelHub,
  type Clock,
  type Db,
  type Deliverable,
  type Envelope,
  type HubSendRequest,
  type OutboxFilter,
  type OutboxRecord,
  type OutboxStatus,
  type SendReceipt,
} from "@ng/protocol";
import { GLOBAL_STATE, countByStatus, insertRow, listRows, readState, rowById, rowByKey, toRecord, writeState, type OutboxRow } from "./outbox";
import { isChannelAdapter, isHttpChannel, type ChannelInfo, type DeliveryResult, type HttpRequestLike, type HttpResponseLike } from "./types";
import { DEFAULT_SEND_TIMEOUT_MS, errorMessage, jsonResponse, receiptToResult, runWithTimeout } from "./util";

export interface ChannelHubOptions {
  db: Db;
  bus: Bus;
  clock?: Clock;
  /** Checks `actionToken` on sends/edits (kernel wires it to Gate.verifyTokenSync). A token without a verifier is refused. */
  verifyToken?: ActionTokenVerifier;
  /** When true, a send without `actionToken` is refused too (default false: in-process callers are trusted). */
  requireToken?: boolean;
  /** Per-attempt transport deadline; on expiry the receipt is `unknown`. Default 30 s. */
  sendTimeoutMs?: number;
  /** Principal adapters use for the owner's own messages (default `owner`). */
  ownerPrincipal?: string;
}

export type IngressSink = (raw: Omit<Envelope, "to">, channelId: string) => Promise<void>;

export interface FlushReceipt {
  idempotencyKey: string;
  channelId: string;
  target: string;
  receipt: Exclude<SendReceipt, "buffered_dnd">;
}

export interface FlushResult {
  sent: number;
  failed: number;
  unknown: number;
  /** One entry per buffered row delivered by this flush, in delivery (creation) order. */
  receipts: FlushReceipt[];
}

/**
 * - edited: the external message now shows `content` (outbox row content updated)
 * - refused: action token missing/invalid · unsupported: channel cannot edit · not_sent: row is not `sent` or has no external id
 * - failed / unknown: as for sends; the row keeps its old content and records the error
 */
export type EditReceipt = "edited" | "refused" | "unsupported" | "not_sent" | "failed" | "unknown";

export type ResolveUnknownResult = "resolved" | "not_unknown" | "not_found";

export interface ChannelHubImpl extends ChannelHub {
  onIngress(sink: IngressSink): void;
  flushBuffered(): Promise<FlushResult>;
  /** Stops routing a channel's sends and ingress. Returns false if it was not registered. */
  unregister(channelId: string): boolean;
  /** id, kind, capabilities and live status of every registered channel (信源 drawer). */
  listInfoSync(): ChannelInfo[];
  /** Buffered (DND) rows in delivery order — feeds "已暂存 N 条非紧急外部通知". */
  listBufferedSync(): OutboxRecord[];
  /** Routes a webhook request to the channel's `handleRequest` (404 when the channel has no HTTP endpoint). */
  handleHttp(channelId: string, req: HttpRequestLike): Promise<HttpResponseLike>;
  /** Edits an already-sent message on channels that declare `withdrawOrEdit`. */
  edit(idempotencyKey: string, content: Deliverable, opts?: { actionToken?: string }): Promise<EditReceipt>;
  /**
   * A human checked an `unknown` send on the external side and records the verdict (`sent`, or `failed` so it can
   * be retried with `retryFailed`). The note is appended to the row's error for the audit trail.
   */
  resolveUnknownSync(idempotencyKey: string, verdict: "sent" | "failed", note?: string): ResolveUnknownResult;
  /** At startup: rows left `pending` by a previous process become `unknown` (never re-sent). Returns the count. */
  recoverInterruptedSync(): number;
}

type Decision =
  | { kind: "receipt"; receipt: SendReceipt }
  | { kind: "deliver"; row: OutboxRow; channel: Channel };

const INTERRUPTED = "interrupted: the process stopped while this send was in flight; verify on the external side before resending";

export function createChannelHub(opts: ChannelHubOptions): ChannelHubImpl {
  const { db, bus } = opts;
  const clock = opts.clock ?? systemClock;
  const timeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const ownerPrincipal = opts.ownerPrincipal ?? OWNER_PRINCIPAL;
  const channels = new Map<string, Channel>();
  /** Same-key sends issued while one is in flight share its receipt instead of reporting the `pending` row as unknown. */
  const inflight = new Map<string, Promise<SendReceipt>>();
  let sink: IngressSink | null = null;
  let flushChain: Promise<unknown> = Promise.resolve();

  // ---------- helpers ----------

  function emitChanged(row: Pick<OutboxRow, "id" | "idempotency_key" | "channel_id">, status: OutboxStatus): void {
    afterCommit(db, () => bus.emit("outbox.changed", { id: row.id, idempotencyKey: row.idempotency_key, channelId: row.channel_id, status }));
  }

  function emitFocus(on: boolean): void {
    afterCommit(db, () => bus.emit("channel.focus", { on, buffered: countByStatus(db, "buffered_dnd") }));
  }

  function storedReceipt(status: OutboxStatus): SendReceipt {
    return status === "pending" ? "unknown" : status;
  }

  /** Delivery happens after awaits, so a caller's transaction could roll the row back after the message left. */
  function assertNoTx(where: string): void {
    if (inTransaction(db)) throw new NgError("tx_misuse", `ChannelHub.${where} performs network I/O; call it outside a transaction`);
  }

  function assertContent(content: unknown, where: string): void {
    const r = deliverableSchema.safeParse(content);
    if (!r.success) throw new NgError("invalid_argument", `${where}: content is not a Deliverable`, r.error.issues);
  }

  function checkToken(token: string | undefined, target: ChannelAddr, content: Deliverable): { ok: true } | { ok: false; reason: string } {
    if (token === undefined) return opts.requireToken ? { ok: false, reason: "an action token is required" } : { ok: true };
    if (!opts.verifyToken) return { ok: false, reason: "an action token was presented but no verifier is configured" };
    try {
      const r = opts.verifyToken(token, { target, content });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason || "token rejected" };
    } catch (err) {
      return { ok: false, reason: `token verification error: ${errorMessage(err)}` };
    }
  }

  function track(key: string, work: Promise<SendReceipt>): Promise<SendReceipt> {
    const tracked: Promise<SendReceipt> = work.finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
    inflight.set(key, tracked);
    return tracked;
  }

  function transmit(channel: Channel, row: OutboxRow): Promise<DeliveryResult> {
    const content = fromJson<Deliverable>(row.content);
    return runWithTimeout((signal) => {
      if (isChannelAdapter(channel)) {
        return channel.deliver({ target: row.target, content, idempotencyKey: row.idempotency_key, attempt: row.attempts, signal });
      }
      return channel.send({ target: row.target, content, idempotencyKey: row.idempotency_key, respectDnd: false }).then(receiptToResult);
    }, timeoutMs);
  }

  async function deliverRow(row: OutboxRow, channel: Channel): Promise<SendReceipt> {
    const result = await transmit(channel, row);
    withTx(db, () => {
      const now = clock.now();
      const sent = result.status === "sent";
      const r = run(
        db,
        `UPDATE outbox SET status = ?, error = ?, external_id = COALESCE(?, external_id), sent_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        [result.status, sent ? null : result.error, sent ? (result.externalId ?? null) : null, sent ? now : null, now, row.id],
      );
      if (r.changes > 0) emitChanged(row, result.status);
    });
    return result.status;
  }

  function runDecision(key: string, d: Decision): Promise<SendReceipt> {
    return d.kind === "receipt" ? Promise.resolve(d.receipt) : track(key, deliverRow(d.row, d.channel));
  }

  function isFocusSync(): boolean {
    return readState<boolean>(db, GLOBAL_STATE, "focus") === true;
  }

  function checkIngress(channelId: string, raw: Omit<Envelope, "to">): Omit<Envelope, "to"> {
    const bad = (why: string) => new NgError("invalid_argument", `ingress from channel "${channelId}" rejected: ${why}`);
    if (!raw || typeof raw !== "object") throw bad("not an envelope");
    if (typeof raw.id !== "string" || raw.id.length === 0) throw bad("missing id");
    const from = parseAddress(String(raw.from));
    if (!from || from.kind !== "channel" || from.channelId !== channelId) throw bad(`from "${String(raw.from)}" is not channel:${channelId}:<target>`);
    const p = raw.principalId;
    if (typeof p !== "string" || !(p === ownerPrincipal || (p.startsWith(`${channelId}:`) && p.length > channelId.length + 1))) {
      throw bad(`principal "${String(p)}" is neither the owner nor ${channelId}:<externalUserId>`);
    }
    if (raw.kind !== "event" && raw.kind !== "result") throw bad("kind must be event or result");
    if (typeof raw.type !== "string" || raw.type.length === 0) throw bad("missing type");
    if (typeof raw.createdAt !== "number") throw bad("missing createdAt");
    // Routing is the kernel's decision; an adapter cannot pick the destination cell.
    const { to: _ignored, ...clean } = raw as Envelope;
    return clean;
  }

  function wire(channel: Channel): void {
    channel.onIngress(async (raw) => {
      if (channels.get(channel.id) !== channel) throw new NgError("not_found", `channel "${channel.id}" is no longer registered`);
      const env = checkIngress(channel.id, raw);
      if (!sink) throw new NgError("unsupported", "no ingress sink is wired (ChannelHub.onIngress)");
      await sink(env, channel.id);
    });
  }

  // ---------- flush ----------

  async function flushNow(): Promise<FlushResult> {
    const out: FlushResult = { sent: 0, failed: 0, unknown: 0, receipts: [] };
    for (const row of listRows(db, { status: ["buffered_dnd"], order: "oldest" })) {
      const d = withTx(db, (): Decision | null => {
        const now = clock.now();
        const channel = channels.get(row.channel_id);
        if (!channel) {
          const r = run(db, "UPDATE outbox SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'buffered_dnd'",
            [`channel "${row.channel_id}" is not registered`, now, row.id]);
          if (r.changes === 0) return null;
          emitChanged(row, "failed");
          return { kind: "receipt", receipt: "failed" };
        }
        const r = run(db, "UPDATE outbox SET status = 'pending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'buffered_dnd'",
          [now, row.id]);
        if (r.changes === 0) return null;
        emitChanged(row, "pending");
        return { kind: "deliver", row: rowById(db, row.id)!, channel };
      });
      if (!d) continue;
      const receipt = await runDecision(row.idempotency_key, d);
      if (receipt === "buffered_dnd") continue;
      out[receipt]++;
      out.receipts.push({ idempotencyKey: row.idempotency_key, channelId: row.channel_id, target: row.target, receipt });
    }
    return out;
  }

  // ---------- the hub ----------

  const hub: ChannelHubImpl = {
    register(channel) {
      if (!channel.id || channel.id.includes(":")) throw new NgError("invalid_argument", `invalid channel id "${channel.id}"`);
      if (channels.has(channel.id)) throw new NgError("duplicate", `channel "${channel.id}" is already registered`);
      channels.set(channel.id, channel);
      wire(channel);
    },

    unregister(channelId) {
      return channels.delete(channelId);
    },

    get(channelId) {
      return channels.get(channelId);
    },

    list() {
      return [...channels.values()];
    },

    listInfoSync() {
      return [...channels.values()].map((ch) => ({
        id: ch.id,
        kind: isChannelAdapter(ch) ? ch.kind : "custom",
        capabilities: { ...ch.capabilities },
        status: isChannelAdapter(ch) ? ch.status() : { state: "ready", lastIngressAt: null, lastDeliveryAt: null, lastError: null },
      }));
    },

    onIngress(next) {
      sink = next;
    },

    async send(req: HubSendRequest) {
      assertNoTx("send");
      const addr = parseAddress(req.target);
      if (!addr || addr.kind !== "channel") throw new NgError("invalid_argument", `send: "${req.target}" is not a channel address`);
      if (!req.idempotencyKey) throw new NgError("invalid_argument", "send: idempotencyKey is required");
      assertContent(req.content, "send");
      const key = req.idempotencyKey;
      const running = inflight.get(key);
      if (running) return running;

      const d = withTx(db, (): Decision => {
        const existing = rowByKey(db, key);
        if (existing) return { kind: "receipt", receipt: storedReceipt(existing.status) };
        const now = clock.now();
        const base = {
          id: newId("out", clock),
          idempotencyKey: key,
          channelId: addr.channelId,
          target: addr.target,
          content: req.content,
          urgent: req.urgent === true,
          cellId: req.cellId ?? null,
          actionId: req.actionId ?? null,
          now,
        };
        const ref = { id: base.id, idempotency_key: key, channel_id: addr.channelId };
        // Token first: once verified (and consumed) the row records an authorized send, so later retries are legitimate.
        const token = checkToken(req.actionToken, addr.addr, req.content);
        if (!token.ok) {
          insertRow(db, { ...base, status: "failed", refused: true, attempts: 0, error: `refused: ${token.reason}` });
          emitChanged(ref, "failed");
          return { kind: "receipt", receipt: "failed" };
        }
        const channel = channels.get(addr.channelId);
        if (!channel) {
          insertRow(db, { ...base, status: "failed", refused: false, attempts: 0, error: `channel "${addr.channelId}" is not registered` });
          emitChanged(ref, "failed");
          return { kind: "receipt", receipt: "failed" };
        }
        if (req.respectDnd !== false && req.urgent !== true && isFocusSync()) {
          insertRow(db, { ...base, status: "buffered_dnd", refused: false, attempts: 0, error: null });
          emitChanged(ref, "buffered_dnd");
          emitFocus(true);
          return { kind: "receipt", receipt: "buffered_dnd" };
        }
        insertRow(db, { ...base, status: "pending", refused: false, attempts: 1, error: null });
        emitChanged(ref, "pending");
        return { kind: "deliver", row: rowById(db, base.id)!, channel };
      });
      return runDecision(key, d);
    },

    async retryFailed(idempotencyKey) {
      assertNoTx("retryFailed");
      const running = inflight.get(idempotencyKey);
      if (running) return running;
      const d = withTx(db, (): Decision => {
        const row = rowByKey(db, idempotencyKey);
        if (!row) throw new NgError("not_found", `no outbox row for idempotency key "${idempotencyKey}"`);
        if (row.status !== "failed" || row.refused) return { kind: "receipt", receipt: storedReceipt(row.status) };
        const now = clock.now();
        const channel = channels.get(row.channel_id);
        if (!channel) {
          run(db, "UPDATE outbox SET error = ?, updated_at = ? WHERE id = ?", [`channel "${row.channel_id}" is not registered`, now, row.id]);
          emitChanged(row, "failed");
          return { kind: "receipt", receipt: "failed" };
        }
        run(db, "UPDATE outbox SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'",
          [now, row.id]);
        emitChanged(row, "pending");
        return { kind: "deliver", row: rowById(db, row.id)!, channel };
      });
      return runDecision(idempotencyKey, d);
    },

    async streamPreview(target, chunk) {
      const addr = parseAddress(target);
      if (!addr || addr.kind !== "channel") throw new NgError("invalid_argument", `streamPreview: "${target}" is not a channel address`);
      const ch = channels.get(addr.channelId);
      if (!ch || !ch.capabilities.streamingPreview || !ch.streamPreview) return;
      try {
        await ch.streamPreview(addr.target, chunk);
      } catch {
        // Preview is best-effort decoration of an in-flight Run; the final send carries the real receipt.
      }
    },

    flushBuffered() {
      try {
        assertNoTx("flushBuffered");
      } catch (err) {
        return Promise.reject(err);
      }
      const p = flushChain.then(flushNow, flushNow);
      flushChain = p.catch(() => undefined);
      return p;
    },

    async edit(idempotencyKey, content, editOpts = {}) {
      assertNoTx("edit");
      assertContent(content, "edit");
      const row = rowByKey(db, idempotencyKey);
      if (!row) throw new NgError("not_found", `no outbox row for idempotency key "${idempotencyKey}"`);
      if (row.status !== "sent" || !row.external_id) return "not_sent";
      const ch = channels.get(row.channel_id);
      if (!ch || !ch.capabilities.withdrawOrEdit || !isChannelAdapter(ch) || !ch.edit) return "unsupported";
      const editFn = ch.edit.bind(ch);
      const externalId = row.external_id;
      const token = withTx(db, () => checkToken(editOpts.actionToken, channelAddr(row.channel_id, row.target), content));
      if (!token.ok) {
        withTx(db, () => {
          run(db, "UPDATE outbox SET error = ?, updated_at = ? WHERE id = ?", [`edit refused: ${token.reason}`, clock.now(), row.id]);
          emitChanged(row, row.status);
        });
        return "refused";
      }
      const r = await runWithTimeout((signal) => editFn({ target: row.target, externalId, content, signal }), timeoutMs);
      withTx(db, () => {
        const now = clock.now();
        if (r.status === "sent") {
          run(db, "UPDATE outbox SET content = ?, external_id = COALESCE(?, external_id), error = NULL, updated_at = ? WHERE id = ?",
            [JSON.stringify(content), r.externalId ?? null, now, row.id]);
        } else {
          run(db, "UPDATE outbox SET error = ?, updated_at = ? WHERE id = ?", [`edit ${r.status}: ${r.error}`, now, row.id]);
        }
        emitChanged(row, row.status);
      });
      return r.status === "sent" ? "edited" : r.status;
    },

    resolveUnknownSync(idempotencyKey, verdict, note) {
      return withTx(db, (): ResolveUnknownResult => {
        const row = rowByKey(db, idempotencyKey);
        if (!row) return "not_found";
        if (row.status !== "unknown") return "not_unknown";
        const now = clock.now();
        const audit = `${row.error ? `${row.error}; ` : ""}verified on the external side as ${verdict}${note ? `: ${note}` : ""}`;
        run(db, "UPDATE outbox SET status = ?, error = ?, sent_at = ?, updated_at = ? WHERE id = ? AND status = 'unknown'",
          [verdict, audit, verdict === "sent" ? now : null, now, row.id]);
        emitChanged(row, verdict);
        return "resolved";
      });
    },

    recoverInterruptedSync() {
      return withTx(db, () => {
        let n = 0;
        const now = clock.now();
        for (const row of listRows(db, { status: ["pending"], order: "oldest" })) {
          if (inflight.has(row.idempotency_key)) continue;
          run(db, "UPDATE outbox SET status = 'unknown', error = ?, updated_at = ? WHERE id = ? AND status = 'pending'", [INTERRUPTED, now, row.id]);
          emitChanged(row, "unknown");
          n++;
        }
        return n;
      });
    },

    async handleHttp(channelId, req) {
      const ch = channels.get(channelId);
      if (!ch || !isHttpChannel(ch)) return jsonResponse(404, { error: "unknown_channel" });
      try {
        return await ch.handleRequest(req);
      } catch {
        return jsonResponse(500, { error: "internal_error" });
      }
    },

    setFocusSync(on) {
      withTx(db, () => {
        const was = isFocusSync();
        writeState(db, GLOBAL_STATE, "focus", on, clock.now());
        if (was !== on) emitFocus(on);
      });
    },

    isFocusSync,

    bufferedCountSync() {
      return countByStatus(db, "buffered_dnd");
    },

    listBufferedSync() {
      return listRows(db, { status: ["buffered_dnd"], order: "oldest" }).map(toRecord);
    },

    listOutboxSync(filter?: OutboxFilter) {
      return listRows(db, filter).map(toRecord);
    },

    getOutboxSync(idempotencyKey) {
      const row = rowByKey(db, idempotencyKey);
      return row ? toRecord(row) : undefined;
    },
  };
  return hub;
}
