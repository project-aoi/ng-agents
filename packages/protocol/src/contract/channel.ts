import type { Deliverable } from "./deliverable";
import type { Envelope } from "./envelope";

export type IngressEmit = (raw: Omit<Envelope, "to">) => Promise<void>;

export interface Channel {
  /** The registered workbench ingress may forward an authenticated control-plane identity. */
  readonly workbenchIngress?: true;
  readonly id: string;
  onIngress(emit: IngressEmit): void;
}

export interface LocalNotification {
  id: string;
  cellId: string;
  content: Deliverable;
  createdAt: number;
}

export interface ChannelHub {
  register(channel: Channel): void;
  get(channelId: string): Channel | undefined;
  list(): Channel[];
  onIngress(sink: (raw: Omit<Envelope, "to">, channelId: string) => Promise<void>): void;
  notifyOwner(input: { cellId: string; content: Deliverable; idempotencyKey: string }): void;
  listNotificationsSync(limit?: number): LocalNotification[];
}
