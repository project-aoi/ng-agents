import { STANDARD_TOOLSETS } from "@ng/loop";

/** Registered names. Specs are persisted, so these strings are a storage format: never rename them. */
export const PROMPTS = {
  desk: "gtd.desk",
  worker: "gtd.worker",
  sensor: "gtd.sensor",
  /** docs/05: the persistent project coordinator. */
  project: "gtd.project",
  /** docs/05: the `checker` preset's default — a light one-shot checker of one outside condition. */
  checker: "gtd.checker",
  /** docs/05: the persistent router of one stream of direct messages. */
  hub: "gtd.hub",
} as const;

export const TOOLSETS = {
  desk: "gtd.desk",
  sensor: "gtd.sensor",
  /** docs/05: dispatch, track_action, update_project, finish_project. */
  project: "gtd.project",
} as const;

export const PROCESSORS = {
  /** Sensor that runs a script through its workspace (args.script). */
  sensorScript: "gtd.sensor_script",
  /** A checker dispatched with a check command (probe.ts): runs it on a timer, zero tokens until it reports. */
  checkProbe: "gtd.check_probe",
} as const;


/** `spec.meta.role` of every cell the presets create (handy for routing a scripted model by role). */
export const ROLES = {
  desk: "desk",
  project: "project",
  hub: "hub",
  worker: "worker",
  /** The one-shot checker (preset `checker`'s default). */
  checker: "checker",
  sensor: "sensor",
} as const;

export const STD = STANDARD_TOOLSETS;

/** Internal (non-GTD) state keys. GTD records use `gtdKeys` from @ng/protocol. */
export const KEYS = {
  /** In a checker with a check command: ProbeState. */
  probe: "probe:state",
  /** Weekly-review suggestions the app lists (shapes owned by apps/gtd-desk). */
  skillSuggestion: (slug: string) => `desk:suggestion:skill:${slug}`,
  sensorSuggestion: (sensorCellId: string) => `desk:suggestion:sensor:${sensorCellId}`,
} as const;

/**
 * `handback.reason` of an item the owner restored from the archive ("交回主台"). Same text the app
 * sends; such an item must get a card, never be archived again.
 */
export const RESTORE_REASON = "主人把这条归档记录交回了主台，请为它准备一张「待我处理」卡片。";

export interface RegisterPresetsOptions {
  /** The desk cell id (default "desk"). Must match the kernel's `deskCellId`. */
  deskCellId?: string;
  /** IANA zone for times shown to the owner ("已设好 11月20日周五 15:00 提醒"). Default "Asia/Shanghai". */
  timeZone?: string;
  /**
   * When the desk wakes for its weekly review (skill and code-check suggestions): a 5-field cron in `timeZone`.
   * Default "0 16 * * 5" (Friday 16:00); false = no scheduled review.
   */
  weeklyReview?: string | false;
}

export interface PresetsConfig {
  deskCellId: string;
  timeZone: string;
  weeklyReview: string | false;
}

export const DAY_MS = 24 * 3_600_000;

export function resolveConfig(opts: RegisterPresetsOptions = {}): PresetsConfig {
  return {
    deskCellId: opts.deskCellId ?? "desk",
    timeZone: opts.timeZone ?? "Asia/Shanghai",
    weeklyReview: opts.weeklyReview ?? "0 16 * * 5",
  };
}
