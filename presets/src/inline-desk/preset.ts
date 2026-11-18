import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { DESK_PROCESSOR } from "../shared/processors";
import type { DeskBooks } from "./items";

export function deskPreset(books: DeskBooks): PresetDef {
  return {
    name: "inline",
    description: "The main desk: triage, quick personal items, reply drafts, starting projects, arbitration. Read-only in its directory; delegates everything slow.",
    defaults: { processor: DESK_PROCESSOR, cwdMode: "read", lifetime: "persistent", meta: { role: ROLES.desk } },
    // The desk's books (reminders due, decided cards, finished projects) are kept before the model runs, so they never
    // depend on the model calling a tool; a wake-up with nothing else in it does not reach the model at all.
    prepareRun: (input) => books.prepareRun(input),
  };
}
