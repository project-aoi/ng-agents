// ===== Demo mode =====
// With no CLI agent installed and no API model configured (or NG_DESK_DEMO=1), the desk runs on the scripted demo
// model and, on a fresh data directory, plays a few days of the workbench through the real kernel and presets
// (./demo-seed.ts) so every view has content: notes and reminders, reply cards, a source hit turned into a proposal,
// persistent projects that dispatch one-shot workers — one running, one waiting on the owner, one waiting on
// suppliers' replies, one parked as "someday" with its report — and a hub. Live input still gets an answer: a note or
// link is saved, a reminder is set, a card can be revised, a ticked-off action moves its project on, anything else gets
// an honest "演示模式" note.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Kernel } from "@ng/cell";
import { MemoryChannel, type UiChannel } from "@ng/channel";
import { ScriptedModelClient } from "@ng/loop";
import type { Channel, Clock, ModelClient, Registry } from "@ng/protocol";
import type { Desk } from "./desk";
import { DemoBrain } from "./demo-model";
import { DEMO_CHANNEL_ID, DEMO_SEED_KEY, DEMO_SEED_VERSION, DemoClock, demoMetricsCheck, demoPaymentCheck, demoStart, seedDemo } from "./demo-seed";

export interface SeedContext {
  kernel: Kernel;
  /** The 随手记 channel (capture as the owner). */
  ui: UiChannel;
  /** The synchronous endpoints, for pressing buttons the way the web client does. */
  desk: Desk;
  clock: Clock;
  dataDir: string;
  /** True when this start created the desk (an empty data directory). */
  fresh: boolean;
  log: (line: string) => void;
}

export interface DemoMode {
  model(): ModelClient;
  /** The clock of a demo boot, chosen before the database is opened (default: the system clock). */
  clock?(dataDir: string): Clock;
  /** Registers what the demo's cells refer to by name (e.g. its zero-token checks), before the kernel starts. */
  setup?(registry: Registry): void;
  /** Extra channels for the kernel (the demo's colleagues). */
  channels?(clock: Clock): Channel[];
  /** Called on every demo start once the kernel runs (and the desk exists). */
  seed?(ctx: SeedContext): Promise<void> | void;
}

export const DEMO_NOTICE =
  "（演示模式：没有可用的 Agent，这条消息不会被真正处理。安装 Claude Code / Codex / Antigravity CLI，或配置 ANTHROPIC_API_KEY 后重启即可。）";

/** Ends every Run with one line instead of doing anything (no seed, no scenarios). */
export function placeholderDemoModel(): ModelClient {
  return new ScriptedModelClient(() => ({ text: DEMO_NOTICE }), { models: { strong: "demo", fast: "demo" } });
}

export const PLACEHOLDER_DEMO: DemoMode = { model: placeholderDemoModel };

/**
 * The real demo: a role-routed scripted model, a MemoryChannel `demo` playing colleagues and suppliers, and a seed
 * that runs once per data directory (a directory that already holds a database is never seeded: demo content must not
 * end up among real records).
 */
export function createDemoMode(opts: { timeZone?: string } = {}): DemoMode {
  const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let clock: DemoClock | null = null;
  let brain: DemoBrain | null = null;
  let im: MemoryChannel | null = null;
  const clockOf = () => (clock ??= new DemoClock());
  const brainOf = () => (brain ??= new DemoBrain({ clock: clockOf(), timeZone }));

  return {
    model: () => brainOf().model,
    clock(dataDir) {
      const c = clockOf();
      if (!existsSync(join(dataDir, "ng.db"))) c.startFrom(demoStart(timeZone));
      return c;
    },
    setup(registry) {
      for (const check of [demoMetricsCheck, demoPaymentCheck]) if (!registry.codeProcessors.has(check.name)) registry.codeProcessors.register(check);
    },
    channels(kernelClock) {
      im ??= new MemoryChannel({ id: DEMO_CHANNEL_ID, clock: kernelClock });
      return [im];
    },
    async seed(ctx) {
      const { kernel } = ctx;
      const seeded = kernel.context.readStateSync(kernel.deskCellId, DEMO_SEED_KEY);
      if (seeded !== null) return;
      if (!ctx.fresh || !clock?.travelling || !im) {
        if (clock) clock.catchUp();
        ctx.log("demo: this data directory was not created by the demo; nothing is seeded into it");
        return;
      }
      const started = Date.now();
      try {
        await seedDemo({ kernel, desk: ctx.desk, im, brain: brainOf(), clock, timeZone, log: ctx.log });
      } finally {
        clock.catchUp();
      }
      kernel.context.commitSync(kernel.deskCellId, { statePatches: { [DEMO_SEED_KEY]: { version: DEMO_SEED_VERSION, at: kernel.clock.now() } } });
      ctx.log(`demo: seeded the demo scenarios in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    },
  };
}
