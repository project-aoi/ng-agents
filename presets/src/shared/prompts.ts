import type { PromptDef } from "@ng/protocol";
import { PROMPTS } from "./config";

/** The helper a root spawns to redraft its result card ("🎙 按住口述修改意见"). */
export function editorPrompt(): PromptDef {
  return {
    name: PROMPTS.editor,
    description: "redraft one text from the owner's spoken feedback",
    text: `You rewrite one draft according to the owner's spoken feedback (both are in your task message). Change exactly what they asked, keep everything else, keep the language and tone right for whoever will read it, and hand back the complete new text with submit_draft. No commentary inside the draft; keep any \`> [!DECISION] …\` lines that still apply.`,
  };
}
