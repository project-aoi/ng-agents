import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const templates = [
  "packages/context/src/hydrate", "packages/context/src/render", "packages/context/src/summarize",
  "packages/loop/src/cli/input", "packages/loop/src/cli/instructions", "packages/loop/src/cli/render",
];

let version: string | undefined;

/** Registered prompts, skills and tool contracts are included directly in the cell's prefix hash. */
export function runtimeVersion(): string {
  if (version) return version;
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const hash = createHash("sha256");
  for (const template of templates) {
    const source = join(root, template + ".ts");
    const path = existsSync(source) ? source : join(root, template.replace("/src/", "/dist/") + ".js");
    hash.update(template).update("\0").update(readFileSync(path)).update("\0");
  }
  return (version = hash.digest("hex"));
}
