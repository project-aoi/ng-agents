import type { ContextStore } from "@ng/protocol";
import { BUILTIN_SKILLS } from "./skills";

export function seedBuiltinSkills(context: Pick<ContextStore, "getKnowledgeSync" | "upsertSkillOrNoteSync">, deskCellId: string): string[] {
  const written: string[] = [];
  for (const s of BUILTIN_SKILLS) {
    const installed = context.getKnowledgeSync({ kind: "skill", name: s.name, scope: "global" });
    if (installed) continue;
    context.upsertSkillOrNoteSync(deskCellId, { kind: "skill", name: s.name, description: s.description, body: s.body, tags: s.tags, scope: "global", mode: "upsert" });
    written.push(s.name);
  }
  return written;
}
