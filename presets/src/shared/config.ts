import { STANDARD_TOOLSETS } from "@ng/loop";
import type { ChannelAddr } from "@ng/protocol";

/** Registered names. Specs are persisted, so these strings are a storage format: never rename them. */
export const PROMPTS = {
  desk: "gtd.desk",
  worker: "gtd.worker",
  watcher: "gtd.watcher",
  sensor: "gtd.sensor",
  editor: "gtd.editor",
} as const;

export const TOOLSETS = {
  desk: "gtd.desk",
  watcher: "gtd.watcher",
  sensor: "gtd.sensor",
  editor: "gtd.editor",
} as const;

export const PROCESSORS = {
  /** Project/item root: zero-token join over its children; holds gtd:project and the item's actions. */
  joinAll: "gtd.join_all",
  /** Same coordinator, groups default to "any" (first result wins). */
  joinAny: "gtd.join_any",
  /** Watcher bookkeeping: one party, reply/timeout/nudge. */
  waitMatch: "gtd.wait_match",
  /** Sensor that runs a script through its workspace (args.script). */
  sensorScript: "gtd.sensor_script",
} as const;

/** `spec.meta.role` of every cell the presets create (handy for routing a scripted model by role). */
export const ROLES = {
  desk: "desk",
  coordinator: "coordinator",
  worker: "worker",
  watcher: "watcher",
  sensor: "sensor",
  editor: "editor",
} as const;

export const STD = STANDARD_TOOLSETS;

/** Internal (non-GTD) state keys. GTD records use `gtdKeys` from @ng/protocol. */
export const KEYS = {
  coordinator: "coord:state",
  watcher: "watch:state",
  reply: (subjectKey: string) => `desk:reply:${subjectKey}`,
  replyPrefix: "desk:reply:",
  proposal: (artifactId: string) => `desk:proposal:${artifactId}`,
  /** A reminder not yet turned into a to-do (removed once it is). */
  reminder: (id: string) => `desk:reminder:${id}`,
  reminderPrefix: "desk:reminder:",
  /** Weekly-review suggestions the app lists (shapes owned by apps/gtd-desk). */
  skillSuggestion: (slug: string) => `desk:suggestion:skill:${slug}`,
  sensorSuggestion: (sensorCellId: string) => `desk:suggestion:sensor:${sensorCellId}`,
} as const;

/**
 * `handback.reason` of an item the owner moved back from the archive to Clarify ("移回待确认"). Same text the app
 * sends (apps/gtd-desk/src/server/desk.ts RESTORE_REASON); such an item must get a card, never be archived again.
 */
export const RESTORE_REASON = "主人把这条从归档记录里移回了待确认：请为它准备一张待确认卡片，不要再静默归档。";

export interface RegisterPresetsOptions {
  /** The desk cell id (default "desk"). Must match the kernel's `deskCellId`. */
  deskCellId?: string;
  /** Where light owner notifications go (default "channel:ui:owner"); must be one of the kernel's ownerAddresses. */
  ownerAddress?: ChannelAddr;
  /** IANA zone for times shown to the owner ("已设好 11月20日周五 15:00 提醒"). Default "Asia/Shanghai". */
  timeZone?: string;
  /** How long a watcher waits after a nudge before checking again (default 1 day). */
  followUpMs?: number;
  /** Default wait before a chase times out when the desk gives no deadline (default 1 day). */
  defaultWaitMs?: number;
  /**
   * When the desk wakes for its weekly review (skill and code-check suggestions): a 5-field cron in `timeZone`.
   * Default "0 16 * * 5" (Friday 16:00); false = no scheduled review.
   */
  weeklyReview?: string | false;
}

export interface PresetsConfig {
  deskCellId: string;
  ownerAddress: ChannelAddr;
  timeZone: string;
  followUpMs: number;
  defaultWaitMs: number;
  weeklyReview: string | false;
}

export const DAY_MS = 24 * 3_600_000;

export function resolveConfig(opts: RegisterPresetsOptions = {}): PresetsConfig {
  return {
    deskCellId: opts.deskCellId ?? "desk",
    ownerAddress: opts.ownerAddress ?? "channel:ui:owner",
    timeZone: opts.timeZone ?? "Asia/Shanghai",
    followUpMs: opts.followUpMs ?? DAY_MS,
    defaultWaitMs: opts.defaultWaitMs ?? DAY_MS,
    weeklyReview: opts.weeklyReview ?? "0 16 * * 5",
  };
}
