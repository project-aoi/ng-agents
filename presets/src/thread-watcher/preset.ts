import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { CHECKER_PROCESSOR } from "../shared/processors";

/**
 * The `watcher` preset's default is a light one-shot checker run by a fast model: it looks at one outside condition
 * (with `gh`/`glab`/`git ls-remote`/`test -d`, in the project's directory so its repository and remotes are at hand),
 * keeps looking via its own watches and reminders, and reports once when the condition holds — which closes it, and
 * its timers with it. A leaf: `maxDepth: 0`. The zero-token reply watcher (await_reply) is the same preset with an
 * explicit processor and lifetime "persistent" (replyWatcherSpec).
 */
export function watcherPreset(): PresetDef {
  return {
    name: "watcher",
    description: "Light one-shot checker of one outside condition (MR merged, CI green, a path exists, a reply arrived): looks at the current state first, reports when it holds.",
    defaults: { processor: CHECKER_PROCESSOR, lifetime: "one_shot", meta: { role: ROLES.checker } },
    requestBounds: () => ({ maxDepth: 0 }),
  };
}
