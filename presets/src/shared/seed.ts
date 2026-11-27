import { createHash } from "node:crypto";
import type { ContextStore } from "@ng/protocol";
import { BUILTIN_SKILLS } from "./skills";

const bodyHash = (body: string) => createHash("sha256").update(body.trim()).digest("hex").slice(0, 16);
const HASH_TAG = "builtin-hash:";

/**
 * Bodies of earlier built-in versions, shipped before installs carried their own hash tag. An installed skill whose
 * body is one of these (or matches the hash tag it was installed with) is a built-in nobody edited: it is brought up
 * to date. Any other body is the owner's and is left alone.
 */
const SHIPPED_BEFORE = new Set([
  "96dcd409cc3c8573", "8ff11b264e4e620c", "3c5f87267ba8e77e", "1b39fef834e589f4", "77e59e9988880d54", "c43d84b502bc4ec2", "09b72373bbdc94de",
  "b8ec5ad51862c137", "2ba07db887df2664", "2a239d26ff9b68fd", "dfb0d1b368125e61", "eb7b3de88eaa39c4",
  "ca2a564b33ceaa99", "791bd4e98ff0d3c9", "0c28115eb9de17f4", "bb26db755fe36d40",
  "9002d87a968f0102", "e7bbcb58170096ac", "6baf9308b548bf6b", "8d14cde5df5ca061",
  "d1a6fda1cdbdc284", "fe39ed12d7e3e3c6", "f9727b4158f8ee94",
]);

/** Installs the built-in playbooks that are missing and updates the ones still exactly as shipped; returns their names. */
export function seedBuiltinSkills(context: Pick<ContextStore, "getKnowledgeSync" | "upsertSkillOrNoteSync">, deskCellId: string): string[] {
  const written: string[] = [];
  for (const s of BUILTIN_SKILLS) {
    const hash = bodyHash(s.body);
    const installed = context.getKnowledgeSync({ kind: "skill", name: s.name, scope: "global" });
    if (installed) {
      const current = bodyHash(installed.body);
      const unedited = SHIPPED_BEFORE.has(current) || installed.tags.includes(`${HASH_TAG}${current}`);
      if (current === hash || !unedited) continue;
    }
    context.upsertSkillOrNoteSync(deskCellId, { kind: "skill", name: s.name, description: s.description, body: s.body, tags: [...s.tags, `${HASH_TAG}${hash}`], scope: "global", mode: "upsert" });
    written.push(s.name);
  }
  return written;
}
