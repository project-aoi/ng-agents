import { PAYLOAD, type CellResultPayload, type CodeProcessor, type PromptDef, type Toolset } from "@ng/protocol";
import { LEGACY } from "./config";

// Stand-ins for names that cells created before docs/05 still carry in their stored specs (see LEGACY). They exist
// only so an old database loads and its leftover cells wind down instead of failing on every wake-up.

const LEGACY_SUMMARY = "这个事项是旧版本创建的，已无法继续；请重新发起。";

/**
 * The old zero-token item root: on any wake-up it ends the item as cancelled with a plain explanation for its parent.
 * The kernel delivers that single result and closes the cell (and what is left below it); without the settle port it
 * reports directly.
 */
function legacyRoot(name: string): CodeProcessor {
  return {
    name,
    description: "Pre-docs/05 item root: no longer runs; ends the item as cancelled so it can be started again.",
    async run({ ports }) {
      if (!ports.self.parentId) return "completed";
      if (ports.settleSelf) {
        await ports.settleSelf({ action: "cancel", summary: LEGACY_SUMMARY, force: true });
      } else {
        const payload: CellResultPayload = { childCellId: ports.self.cellId, status: "cancelled", summary: LEGACY_SUMMARY };
        await ports.emitToParent(PAYLOAD.cellResult, payload, { id: `${ports.self.cellId}:legacy` });
      }
      return "completed";
    },
  };
}

export function legacyProcessors(): CodeProcessor[] {
  return [legacyRoot(LEGACY.joinAll), legacyRoot(LEGACY.joinAny)];
}

export function legacyPrompts(): PromptDef[] {
  return [
    {
      name: LEGACY.editor,
      description: "pre-docs/05 redraft helper (no longer used)",
      text: "You are a helper from an older version of this workbench and have nothing left to do. End your turn without calling any tool.",
    },
  ];
}

export function legacyToolsets(): Toolset[] {
  return [{ name: LEGACY.editor, description: "Pre-docs/05 redraft helper: no tools any more.", tools: [] }];
}
