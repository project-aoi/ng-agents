import type {
  CardPrep,
  ClarifyCard,
  Deliverable,
  DraftRef,
  ItemSource,
  ProjectProposal,
  ProjectProposalCard,
} from "@ng/protocol";
import type { RawInput } from "./records";

// Builders for the three Clarify card types (docs/04 §2.2). A card is the `card` Deliverable of a deferred action;
// its `data` is the ClarifyCard the UI renders block by block.

export interface CardBase {
  subjectKey: string;
  title: string;
  source: ItemSource;
  rawInput: RawInput;
  prep: CardPrep;
}

export function cardDeliverable(card: ClarifyCard, body: string): Deliverable {
  return { format: "card", title: card.title, body: body ? `${card.title}\n\n${body}` : card.title, data: card };
}

/** B. Project proposal; the proposal is also a json artifact so "✎ 手动改一下安排" saves with version protection. */
export function proposalCard(base: CardBase, proposal: ProjectProposal, draft?: DraftRef): ProjectProposalCard {
  return { ...base, cardType: "project_proposal", proposal, ...(draft ? { draft } : {}) };
}

export function prep(summary: string, checked: CardPrep["checked"] = []): CardPrep {
  return { summary, checked };
}
