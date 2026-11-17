import { NgError } from "./errors";
import type { Address, ChannelAddr, InboxAddr } from "./contract/envelope";

/** The main desk cell (inline preset); its address is `inbox:desk`. */
export const DESK_CELL_ID = "desk";
/** Default principal of the single human owner (configurable by the app). */
export const OWNER_PRINCIPAL = "owner";

export function inboxAddr(cellId: string): InboxAddr {
  if (!cellId) throw new NgError("invalid_argument", "inboxAddr: empty cellId");
  return `inbox:${cellId}`;
}

/** `channelId` must not contain ":"; `target` may (everything after the second ":" is the target). */
export function channelAddr(channelId: string, target: string): ChannelAddr {
  if (!channelId || channelId.includes(":")) throw new NgError("invalid_argument", `channelAddr: invalid channelId "${channelId}"`);
  if (!target) throw new NgError("invalid_argument", "channelAddr: empty target");
  return `channel:${channelId}:${target}`;
}

export type ParsedAddress =
  | { kind: "inbox"; addr: InboxAddr; cellId: string }
  | { kind: "channel"; addr: ChannelAddr; channelId: string; target: string };

export function parseAddress(value: string): ParsedAddress | null {
  if (value.startsWith("inbox:")) {
    const cellId = value.slice("inbox:".length);
    return cellId ? { kind: "inbox", addr: value as InboxAddr, cellId } : null;
  }
  if (value.startsWith("channel:")) {
    const rest = value.slice("channel:".length);
    const i = rest.indexOf(":");
    if (i <= 0 || i === rest.length - 1) return null;
    return { kind: "channel", addr: value as ChannelAddr, channelId: rest.slice(0, i), target: rest.slice(i + 1) };
  }
  return null;
}

export function isInboxAddr(value: unknown): value is InboxAddr {
  return typeof value === "string" && parseAddress(value)?.kind === "inbox";
}

export function isChannelAddr(value: unknown): value is ChannelAddr {
  return typeof value === "string" && parseAddress(value)?.kind === "channel";
}

export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && parseAddress(value) !== null;
}

export function cellIdOf(addr: InboxAddr): string {
  return addr.slice("inbox:".length);
}

/**
 * Address-pattern rule shared by PolicyBounds.canSendTo and PolicyRule targets: an entry ending in `*` is a prefix
 * wildcard (`inbox:*`, `channel:feishu:*`); anything else must match exactly. A wildcard child entry is covered
 * only by a parent wildcard whose prefix is a prefix of it.
 */
export function addressCovers(pattern: string, value: string): boolean {
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

export function anyCovers(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => addressCovers(p, value));
}

/**
 * Conventional `Envelope.from` values. Cell-to-cell traffic uses the sender's own `inbox:<cellId>`;
 * channel ingress uses the sender's ChannelAddr; schedule firings use `timer:<scheduleId>`.
 */
export const KERNEL_FROM = {
  approval: "kernel:approval",     // approval.resolved
  workspace: "kernel:workspace",   // job.result (envelope id `${jobId}:result`, kind "result", expectedEpoch = job epoch)
  spawn: "kernel:spawn",           // cell.task
  router: "kernel:router",         // re-routed / restored ingress
  handback: "kernel:handback",     // handback to the desk
  control: "kernel:control",       // control.steer
} as const satisfies Record<string, `kernel:${string}`>;

export function timerFrom(scheduleOrLabel: string): `timer:${string}` {
  return `timer:${scheduleOrLabel}`;
}

// ---------- principals ----------

export function cellPrincipal(cellId: string): `cell:${string}` {
  return `cell:${cellId}`;
}

export function externalPrincipal(channelId: string, externalUserId: string): string {
  return `${channelId}:${externalUserId}`;
}

export type ParsedPrincipal =
  | { kind: "owner" }
  | { kind: "cell"; cellId: string }
  | { kind: "external"; channelId: string; userId: string }
  | { kind: "other"; value: string };

export function parsePrincipal(principalId: string, ownerPrincipal: string = OWNER_PRINCIPAL): ParsedPrincipal {
  if (principalId === ownerPrincipal) return { kind: "owner" };
  if (principalId.startsWith("cell:") && principalId.length > 5) return { kind: "cell", cellId: principalId.slice(5) };
  const i = principalId.indexOf(":");
  if (i > 0 && i < principalId.length - 1) return { kind: "external", channelId: principalId.slice(0, i), userId: principalId.slice(i + 1) };
  return { kind: "other", value: principalId };
}
