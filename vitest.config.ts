import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Convention: every workspace package keeps its tests in `<pkg>/test/**/*.test.ts(x)`.
// Each package is its own vitest project named after its package.json name, so
// `pnpm test --project @ng/inbox` (or `pnpm --filter @ng/inbox test`) runs one package.

const repoRoot = dirname(fileURLToPath(import.meta.url));

function workspaceDirs(): string[] {
  const dirs: string[] = [];
  for (const group of ["packages", "apps"]) {
    const base = join(repoRoot, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(`${group}/${entry.name}`);
    }
  }
  dirs.push("presets");
  return dirs.filter((d) => existsSync(join(repoRoot, d, "package.json")));
}

const projects = workspaceDirs().map((dir) => {
  const { name } = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as { name: string };
  return {
    extends: true,
    test: {
      name,
      root: join(repoRoot, dir),
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    },
  };
});

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    projects,
  },
});
