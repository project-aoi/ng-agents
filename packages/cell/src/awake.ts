import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import type { Bus } from "@ng/protocol";

/** The part of a child process the keep-awake uses (a real ChildProcess, or a fake in tests). */
export interface KeepAwakeChild {
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface KeepAwakeOptions {
  bus: Bus;
  /** True while the kernel has a Run in flight or a Job running. */
  isBusy: () => boolean;
  /** Default `process.platform`; only darwin has anything to do. */
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => KeepAwakeChild;
  /** How long nothing must have been busy before the machine may sleep again. Default 30 s. */
  graceMs?: number;
  onError: (err: unknown) => void;
}

export interface KeepAwake {
  start(): void;
  stop(): void;
}

/**
 * BUG-009 / INV-UC07-05: a laptop must not idle-sleep under a Run or a Job. On macOS one `caffeinate -i` child is
 * held from the first busy moment until nothing has been busy for `graceMs`; `-w <our pid>` makes it exit with this
 * process, so a crashed kernel never leaves the machine awake. Driven by Run and Job events, no polling. Elsewhere it
 * does nothing.
 */
export function createKeepAwake(opts: KeepAwakeOptions): KeepAwake {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
  const graceMs = opts.graceMs ?? 30_000;
  let started = false;
  let child: KeepAwakeChild | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  // caffeinate could not run here: reported once and never tried again (no respawn per Run).
  let broken = false;
  const unsubscribe: Array<() => void> = [];

  function fail(err: unknown): void {
    if (broken) return;
    broken = true;
    opts.onError(err);
  }

  function busy(): boolean {
    try {
      return opts.isBusy();
    } catch (err) {
      opts.onError(err);
      return false;
    }
  }

  function clearGrace(): void {
    if (grace) clearTimeout(grace);
    grace = null;
  }

  function hold(): void {
    if (child || broken || !started) return;
    let c: KeepAwakeChild;
    try {
      c = spawn("caffeinate", ["-i", "-w", String(process.pid)], { detached: false, stdio: "ignore" });
    } catch (err) {
      fail(err);
      return;
    }
    child = c;
    c.once("error", (err) => {
      if (child === c) child = null;
      fail(err);
    });
    c.once("exit", (code, signal) => {
      if (child !== c) return; // we released it
      child = null;
      // Stopped from outside (Ctrl-C, killall): the next busy moment holds a new one. Exiting by itself: it cannot work here.
      if (signal === null) fail(new Error(`caffeinate exited on its own (code ${code})`));
    });
    c.unref();
  }

  function release(): void {
    clearGrace();
    const c = child;
    child = null;
    c?.kill("SIGTERM");
  }

  function onBusy(): void {
    if (!busy()) return;
    clearGrace();
    hold();
  }

  /**
   * Something ended. Re-checked only after the grace period, which also covers a `run.finished` emitted while the
   * Run is still counted as active; if work is still going then, the next end event arms this again.
   */
  function onEnded(): void {
    if (!child) return;
    clearGrace();
    grace = setTimeout(() => {
      grace = null;
      if (!busy()) release();
    }, graceMs);
    grace.unref?.();
  }

  return {
    start() {
      if (started || platform !== "darwin") return;
      started = true;
      unsubscribe.push(
        opts.bus.on("run.started", onBusy),
        opts.bus.on("run.finished", onEnded),
        opts.bus.on("job.changed", (e) => (e.state === "running" ? onBusy() : onEnded())),
      );
      // Jobs re-attached at startup announce nothing.
      onBusy();
    },
    stop() {
      started = false;
      for (const u of unsubscribe.splice(0)) u();
      release();
    },
  };
}
