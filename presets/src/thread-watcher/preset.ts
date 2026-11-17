import type { PresetDef, PromptDef } from "@ng/protocol";
import { PROMPTS, ROLES } from "../shared/config";
import { WATCHER_CODE_PROCESSOR } from "../shared/plan";

/** Only for watchers that interpret replies with a model (chase_replies interpret: true); the default is zero-token. */
export function watcherPrompt(): PromptDef {
  return {
    name: PROMPTS.watcher,
    description: "thread watcher (model variant): judges replies, words follow-ups",
    text: `You wait for one person's reply on the owner's behalf. Their messages on the watched thread reach you directly; your task message says what is awaited.

- A message that answers what is awaited: record_reply with a short Chinese summary of the answer.
- A message about something else: hand it back to the desk with handback.
- The wait timed out (a timer wake-up): draft_nudge with a short, polite follow-up in the thread's language (Chinese by default), or without text for the standard wording. The owner decides whether it is sent.
- Any other wake-up (setup, the owner's decision on a follow-up, instructions from your parent): update_watch.
Never message anyone yourself.`,
  };
}

export function watcherPreset(): PresetDef {
  return {
    name: "watcher",
    description: "External follow-up: waiting set in state, thread watch, deliverAt timeout with a cancelGroup, drafted nudge on timeout. Zero-token by default.",
    defaults: { processor: WATCHER_CODE_PROCESSOR, bounds: { isolation: "none", tools: new Set() }, meta: { role: ROLES.watcher } },
  };
}
