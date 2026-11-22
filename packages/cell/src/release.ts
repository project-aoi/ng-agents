import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let version: string | undefined;

/** A local installation can run an uncommitted checkout. Fingerprint the shipped runtime, independent of git HEAD. */
export function runtimeVersion(): string {
  if (version) return version;
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const hash = createHash("sha256");
  function addDirectory(relative: string): void {
    if (!existsSync(join(root, relative))) return;
    const entries = readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) addDirectory(name);
      else if (entry.isFile() && /\.[cm]?[jt]s$/.test(name))
        hash
          .update(name)
          .update("\0")
          .update(readFileSync(join(root, name)))
          .update("\0");
    }
  }
  for (const dir of ["packages/protocol", "packages/inbox", "packages/gate", "packages/channel", "packages/context", "packages/loop", "packages/workspace", "packages/cell", "presets"]) {
    addDirectory(existsSync(join(root, dir, "src")) ? `${dir}/src` : `${dir}/dist`);
  }

  return (version = hash.digest("hex"));
}
