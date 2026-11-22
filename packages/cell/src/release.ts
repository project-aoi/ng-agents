import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "esbuild";
import { cliAdapterFor, kernelSystem, RUN_ENDED_NOTICE, RUN_ALREADY_ENDED } from "@ng/loop";
import { fileURLToPath } from "node:url";

const templates = [
  "packages/context/src/hydrate", "packages/context/src/render", "packages/context/src/summarize",
  "packages/loop/src/cli/input", "packages/loop/src/cli/render",
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
    const code = transformSync(readFileSync(path, "utf8"), {
      loader: path.endsWith(".ts") ? "ts" : "js", target: "esnext", minifyWhitespace: true, legalComments: "none",
    }).code;
    hash.update(template).update("\0").update(code).update("\0");
  }
  // Hash what each CLI is actually told, including capability-specific wording.
  for (const engine of ["claude", "codex", "agy"] as const) {
    const adapter = cliAdapterFor(engine);
    for (let mask = 0; mask < 16; mask++) {
      const caps = {root: "/", write: !!(mask & 1), edit: !!(mask & 2), bash: !!(mask & 4), web: !!(mask & 8), readOnly: (mask & 7) === 0};
      hash.update(kernelSystem("", adapter, caps, [])).update("\0").update(adapter.describePermissions(caps)).update("\0");
    }
  }
  hash.update(RUN_ENDED_NOTICE).update("\0").update(RUN_ALREADY_ENDED);
  return (version = hash.digest("hex"));
}
