import { humanActionDomain } from "../shared/human-actions";
import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { DESK_PROCESSOR } from "../shared/processors";
import { approvedProjectInit, type DeskBooks, type ProposalItem } from "./items";
import { projectLaunch } from "../project/launch";
import { KEYS } from "../shared/config";

export function deskPreset(books: DeskBooks): PresetDef {
  return {
    name: "inline",
    description: "The main desk: the owner's standing assistant — conversation, triage, quick personal items, reply drafts, starting projects, arbitration. Read-only in its directory; delegates everything slow.",
    defaults: { processor: DESK_PROCESSOR, lifetime: "persistent", meta: { role: ROLES.desk } },
    // The desk's books (reminders due, decided cards, finished projects) are kept before the model runs, so they never
    // depend on the model calling a tool; a wake-up with nothing else in it does not reach the model at all.
    stateDomain: humanActionDomain,
    approvedSpawn(rec, store, clock) {
      if (rec.action.type !== "project.start") return;
      const version = rec.artifactId && rec.boundVersion ? store.getArtifactVersionSync(rec.artifactId, rec.boundVersion) : null;
      return projectLaunch(approvedProjectInit(rec.actionId,{...rec.action,card:rec.card},version,null,clock),clock);
    },
    personalReminder: books.personalReminder,
    prepareRun: (input) => books.prepareRun(input),
  };
}
