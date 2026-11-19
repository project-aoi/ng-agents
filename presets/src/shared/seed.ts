import { createHash } from "node:crypto";
import type { ContextStore } from "@ng/protocol";
import { BUILTIN_SKILLS, SUPERSEDED_SKILL_DIGESTS } from "./skills";

/**
 * Fingerprint of a playbook as it is installed (description as the store normalizes it, body, tags): what tells an
 * untouched copy of a text we shipped from one the owner edited.
 */
export function skillDigest(s: { description: string; body: string; tags: readonly string[] }): string {
  return createHash("sha256")
    .update(JSON.stringify([s.description.replace(/\s+/g, " ").trim(), s.body, s.tags]))
    .digest("hex");
}

/**
 * Install the built-in playbooks (skills.ts) as global skills — a SKILL.md under `<dataDir>/skills/<name>/` plus its
 * index row. A playbook no global skill of that name exists for yet is created. One that exists is replaced with the
 * current text only while it is still exactly a text an earlier version shipped (SUPERSEDED_SKILL_DIGESTS): an install
 * from before the playbook changed gets the new text, while a file the owner edited (or replaced) wins and is left
 * alone. Call once at startup, after the context store has rescanned the skills directory (which createKernel does), so
 * an edited file on disk is what gets compared. Returns the names it wrote.
 */
export function seedBuiltinSkills(context: Pick<ContextStore, "getKnowledgeSync" | "upsertSkillOrNoteSync">, deskCellId: string): string[] {
  const written: string[] = [];
  for (const s of BUILTIN_SKILLS) {
    const installed = context.getKnowledgeSync({ kind: "skill", name: s.name, scope: "global" });
    if (installed && !SUPERSEDED_SKILL_DIGESTS[s.name]?.includes(skillDigest(installed))) continue;
    context.upsertSkillOrNoteSync(deskCellId, { kind: "skill", name: s.name, description: s.description, body: s.body, tags: s.tags, scope: "global", mode: "upsert" });
    written.push(s.name);
  }
  return written;
}
