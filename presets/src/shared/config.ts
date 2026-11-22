import { STANDARD_TOOLSETS } from "@ng/loop";
import type { ChannelAddr } from "@ng/protocol";

/** Registered names. Specs are persisted, so these strings are a storage format: never rename them. */
export const PROMPTS = {
  desk: "gtd.desk",
  worker: "gtd.worker",
  /** The reply watcher's model variant (await_reply interpret: true). The name predates docs/05 and is stored in specs. */
  watcher: "gtd.watcher",
  sensor: "gtd.sensor",
  /** docs/05: the persistent project coordinator. */
  project: "gtd.project",
  /** docs/05: the `watcher` preset's default — a light one-shot checker of one outside condition. */
  checker: "gtd.checker",
  /** docs/05: the persistent router of one stream of direct messages. */
  hub: "gtd.hub",
} as const;

export const TOOLSETS = {
  desk: "gtd.desk",
  watcher: "gtd.watcher",
  sensor: "gtd.sensor",
  /** docs/05: dispatch, track_action, await_reply, update_project, finish_project. */
  project: "gtd.project",
} as const;

export const PROCESSORS = {
  /** Reply watcher bookkeeping (await_reply): one party, reply/timeout/nudge. */
  waitMatch: "gtd.wait_match",
  /** Sensor that runs a script through its workspace (args.script). */
  sensorScript: "gtd.sensor_script",
  /** A watcher dispatched with a check command (probe.ts): runs it on a timer, zero tokens until it reports. */
  checkProbe: "gtd.check_probe",
} as const;

/**
 * Names that cells created before docs/05 may still carry in their stored specs. They stay registered (as stand-ins
 * that wind such a cell down) so an old database never fails to load; nothing new is created with them.
 */
export const LEGACY = {
  /** The zero-token item root that ran every project before docs/05. */
  joinAll: "gtd.join_all",
  joinAny: "gtd.join_any",
  /** The redraft helper of the old item root (prompt and toolset share the name). */
  editor: "gtd.editor",
} as const;

/** `spec.meta.role` of every cell the presets create (handy for routing a scripted model by role). */
export const ROLES = {
  desk: "desk",
  project: "project",
  hub: "hub",
  worker: "worker",
  /** The one-shot checker (preset `watcher`'s default). */
  checker: "checker",
  /** The reply watcher (await_reply). */
  watcher: "watcher",
  sensor: "sensor",
} as const;

export const STD = STANDARD_TOOLSETS;

/** Internal (non-GTD) state keys. GTD records use `gtdKeys` from @ng/protocol. */
export const KEYS = {
  /** In a reply watcher (await_reply): WatcherState. */
  watcher: "watch:state",
  /** In a watcher with a check command: ProbeState. */
  probe: "probe:state",
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
  /** How long a reply watcher waits after a nudge before checking again (default 1 day). */
  followUpMs?: number;
  /** Default wait before await_reply times out when the project gives no deadline (default 1 day). */
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
