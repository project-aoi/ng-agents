import { NgError, systemClock, type AgentLoop, type Clock, type Registry } from "@ng/protocol";

/** Runs a registered code processor with the current cell's ports. */
export function createCodeLoop(registry: Registry, clock: Clock = systemClock): AgentLoop {
  return {
    async run(snapshot, ports, signal) {
      if (signal.aborted) return "cancelled";
      const processor = snapshot.spec.processor;
      if (processor.kind !== "code") throw new NgError("invalid_argument", "An LLM run requires a CLI engine");
      try {
        const result = await raceAbort(registry.codeProcessors.require(processor.entry).run({
          snapshot, ports, signal, args: processor.args ?? {}, clock,
        }), signal);
        return signal.aborted ? "cancelled" : result;
      } catch (err) {
        if (signal.aborted) return "cancelled";
        throw err;
      }
    },
  };
}

/** Settles with `p`, or rejects as soon as `signal` aborts (the underlying work is told through the same signal). */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
