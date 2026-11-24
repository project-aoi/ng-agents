import {
  NgError, OWNER_PRINCIPAL, afterCommit, all, deliverableSchema, parseAddress, run, sha256Hex, systemClock,
  type Bus, type Channel, type ChannelHub, type Clock, type Db, type Envelope, type LocalNotification,
} from "@ng/protocol";


export interface ChannelHubOptions {
  db: Db;
  bus: Bus;
  clock?: Clock;
  ownerPrincipal?: string;
}

export function createChannelHub({ db, bus, clock = systemClock, ownerPrincipal = OWNER_PRINCIPAL }: ChannelHubOptions): ChannelHub {
  const channels = new Map<string, Channel>();
  let sink: Parameters<ChannelHub["onIngress"]>[0] | undefined;

  function checkIngress(channelId: string, raw: Omit<Envelope, "to">): Omit<Envelope, "to"> {
    const bad = (why: string) => new NgError("invalid_argument", `ingress from channel "${channelId}" rejected: ${why}`);
    if (!raw || typeof raw !== "object") throw bad("not an envelope");
    if (typeof raw.id !== "string" || raw.id.length === 0) throw bad("missing id");
    const from = parseAddress(String(raw.from));
    if (!from || from.kind !== "channel" || from.channelId !== channelId) throw bad(`from "${String(raw.from)}" is not channel:${channelId}:<target>`);
    const p = raw.principalId;
    if (typeof p !== "string" || !(p === ownerPrincipal || (channels.get(channelId)?.workbenchIngress === true && /^agent:[a-z0-9][a-z0-9_-]{0,31}$/.test(p)) || (p.startsWith(`${channelId}:`) && p.length > channelId.length + 1))) {
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
      const env = checkIngress(channel.id, raw);
      if (!sink) throw new NgError("unsupported", "no ingress sink is wired (ChannelHub.onIngress)");
      await sink(env, channel.id);
    });
  }

  return {
    register(channel) {
      if (!channel.id || channel.id.includes(":")) throw new NgError("invalid_argument", "invalid channel id");
      if (channels.has(channel.id)) throw new NgError("conflict", `channel "${channel.id}" already registered`);
      channels.set(channel.id, channel);
      wire(channel);
    },
    get: id => channels.get(id),
    list: () => [...channels.values()],
    onIngress(handler) { sink = handler; },
    notifyOwner({ cellId, content, idempotencyKey }) {
      if (!idempotencyKey) throw new NgError("invalid_argument", "notification key is required");
      deliverableSchema.parse(content);
      const id = sha256Hex(JSON.stringify([cellId, idempotencyKey]));
      const createdAt = clock.now();
      const result = run(db, `INSERT INTO owner_notifications(id, cell_id, content, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`, [id, cellId, JSON.stringify(content), createdAt]);
      if (result.changes) afterCommit(db, () => bus.emit("owner.notified", { id, cellId, content, createdAt }));
    },
    listNotificationsSync(limit = 50, { cellIds, since = 0 } = {}) {
      return all<Omit<LocalNotification, "content"> & { content: string }>(db,
        `SELECT id, cell_id AS cellId, content, created_at AS createdAt FROM owner_notifications
         WHERE created_at >= ?${cellIds ? " AND cell_id IN (SELECT value FROM json_each(?))" : ""}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`, [since, ...(cellIds ? [JSON.stringify(cellIds)] : []), limit])
        .map(row => ({ ...row, content: JSON.parse(row.content) }));
    },
  };
}
