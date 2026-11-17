import { z } from "zod";
import { defineTool, PAYLOAD, type CellResultPayload, type Toolset } from "@ng/protocol";
import { TOOLSETS } from "./config";

/**
 * The redraft helper a root spawns for "🎙 按住口述修改意见" on its result card: the root keeps the books and the card,
 * this child only writes the new text.
 */
export function editorToolset(): Toolset {
  return {
    name: TOOLSETS.editor,
    description: "Hand a rewritten draft back.",
    tools: [
      defineTool({
        name: "submit_draft",
        kind: "kernel",
        description: "Hand back the complete rewritten draft (the full text, not a diff). Ends your task.",
        input: z.object({ text: z.string().min(1), note: z.string().optional().describe("what you changed, one line") }),
        async handler(args, ctx) {
          const payload: CellResultPayload = {
            childCellId: ctx.ports.self.cellId,
            status: "completed",
            summary: args.note ?? "草稿已改好",
            data: { draft: args.text },
          };
          await ctx.ports.emitToParent(PAYLOAD.cellResult, payload, { id: `${ctx.ports.self.cellId}:draft` });
          return { output: "Draft handed back.", endRun: "completed" };
        },
      }),
    ],
  };
}
