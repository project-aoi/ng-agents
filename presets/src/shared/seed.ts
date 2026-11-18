import type { ContextStore } from "@ng/protocol";
import { BUILTIN_SKILLS } from "./skills";

/**
 * Install the built-in playbooks (skills.ts) as global skills — a SKILL.md under `<dataDir>/skills/<name>/` plus its
 * index row — but only those no global skill of that name exists for yet: the owner may have edited (or replaced) a
 * file, and that edit wins. Call once at startup, after the context store has rescanned the skills directory (which
 * createKernel does), so an edited file on disk counts as existing. Returns the names it created.
 */
export function seedBuiltinSkills(context: Pick<ContextStore, "getKnowledgeSync" | "upsertSkillOrNoteSync">, deskCellId: string): string[] {
  const created: string[] = [];
  for (const s of BUILTIN_SKILLS) {
    if (context.getKnowledgeSync({ kind: "skill", name: s.name, scope: "global" })) continue;
    context.upsertSkillOrNoteSync(deskCellId, { kind: "skill", name: s.name, description: s.description, body: s.body, tags: s.tags, scope: "global", mode: "upsert" });
    created.push(s.name);
  }
  return created;
}
