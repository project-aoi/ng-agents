import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { DESK_PROCESSOR } from "../shared/processors";
import { approvedProjectInit, type DeskBooks } from "./items";
import { projectLaunch } from "../project/launch";

export function deskPreset(books: DeskBooks): PresetDef {
  return {
    name: "inline",
    description: "The main desk: the owner's standing assistant — conversation, triage, quick personal items, starting projects, arbitration. Delegates long-running work to projects.",
    defaults: { processor: DESK_PROCESSOR, lifetime: "persistent", meta: { role: ROLES.desk } },
    // The desk's books (reminders due, decided cards, finished projects) are kept before the model runs, so they never
    // depend on the model calling a tool; a wake-up with nothing else in it does not reach the model at all.
    approvedSpawn(rec, store, clock) {
      if (rec.action.type !== "project.start") return;
      const version = rec.artifactId && rec.boundVersion ? store.getArtifactVersionSync(rec.artifactId, rec.boundVersion) : null;
      return projectLaunch(approvedProjectInit(rec.actionId,{...rec.action,card:rec.card},version,null,clock),clock);
    },
    personalReminder: books.personalReminder,
    prepareRun: (input) => books.prepareRun(input),
  };
}
