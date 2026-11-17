import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNgError } from "@ng/protocol";
import { detectRipgrep } from "../src";
import { cleanupAll, harness, tempDir } from "./helpers";

afterEach(cleanupAll);

function fixture(): string {
  const dir = tempDir("search");
  mkdirSync(join(dir, "src/deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
  mkdirSync(join(dir, ".hidden"));
  mkdirSync(join(dir, "build"));
  writeFileSync(join(dir, "src/app.ts"), "export function add(a, b) {\n  return a + b; // TODO: overflow\n}\n");
  writeFileSync(join(dir, "src/deep/util.ts"), "// TODO: remove\nexport const x = 1;\n");
  writeFileSync(join(dir, "src/notes.md"), "会议纪要：项目进度延迟，TODO 跟进报价\n");
  writeFileSync(join(dir, "node_modules/pkg/index.js"), "// TODO in dependency\n");
  writeFileSync(join(dir, ".hidden/x.ts"), "// TODO hidden\n");
  writeFileSync(join(dir, "build/out.js"), "// TODO built\n");
  writeFileSync(join(dir, "debug.log"), "TODO log line\n");
  writeFileSync(join(dir, ".gitignore"), "build/\n*.log\n");
  writeFileSync(join(dir, "image.bin"), Buffer.from([0x54, 0x4f, 0x44, 0x4f, 0, 1, 2]));
  return dir;
}

describe("search (built-in fallback — the path that runs here, where no rg binary is on PATH)", () => {
  it("finds regex matches, skipping hidden, ignored, dependency and binary files", async () => {
    const h = harness({ defaultRepoPath: fixture(), ripgrep: false });
    expect(h.mgr.searchBackend).toBe("builtin");
    const port = await h.mgr.acquire("w1", "shared_ro");
    const r = await port.exec("read", { op: "search", pattern: "TODO:?\\s" });
    expect(r.output).toBe(
      ["src/app.ts:2:  return a + b; // TODO: overflow", "src/deep/util.ts:1:// TODO: remove", "src/notes.md:1:会议纪要：项目进度延迟，TODO 跟进报价", ""].join("\n"),
    );
  });

  it("supports literal patterns, globs, a sub-path, Chinese text and result caps", async () => {
    const h = harness({ defaultRepoPath: fixture(), ripgrep: false });
    const port = await h.mgr.acquire("w1", "shared_ro");
    expect((await port.exec("read", { op: "search", pattern: "a + b", literal: true })).output).toBe("src/app.ts:2:  return a + b; // TODO: overflow\n");
    expect((await port.exec("read", { op: "search", pattern: "TODO", glob: "*.md" })).output).toBe("src/notes.md:1:会议纪要：项目进度延迟，TODO 跟进报价\n");
    expect((await port.exec("read", { op: "search", pattern: "TODO", glob: "!*.md" })).output.split("\n").filter(Boolean)).toHaveLength(2);
    expect((await port.exec("read", { op: "search", pattern: "TODO", glob: "src/deep/**" })).output).toBe("src/deep/util.ts:1:// TODO: remove\n");
    expect((await port.exec("read", { op: "search", pattern: "TODO", path: "src/deep" })).output).toBe("src/deep/util.ts:1:// TODO: remove\n");
    expect((await port.exec("read", { op: "search", pattern: "项目进度" })).output).toContain("src/notes.md:1:");
    const capped = await port.exec("read", { op: "search", pattern: "TODO", maxResults: 1 });
    expect(capped.truncated).toBe(true);
    expect(capped.output).toMatch(/^src\/app\.ts:2:.*\n\[\.\.\. stopped at 1 matches/);
    expect((await port.exec("read", { op: "search", pattern: "no-such-text" })).output).toBe("No matches.\n");
    await expect(port.exec("read", { op: "search", pattern: "(unclosed" })).rejects.toSatisfy((e) => isNgError(e, "invalid_argument"));
  });
});

describe("ripgrep detection", () => {
  it("only accepts an executable file named rg on PATH (a shell function does not count)", () => {
    const bin = tempDir("bin");
    expect(detectRipgrep(bin)).toBeNull();
    writeFileSync(join(bin, "rg"), "#!/bin/sh\n");
    expect(detectRipgrep(bin)).toBeNull();
    chmodSync(join(bin, "rg"), 0o755);
    expect(detectRipgrep(`/nonexistent:${bin}`)).toBe(join(bin, "rg"));
  });

  it("uses rg when one is configured (exercised with a grep-backed stand-in)", async () => {
    const bin = tempDir("bin");
    const fake = join(bin, "rg");
    writeFileSync(
      fake,
      `#!/bin/sh
# Minimal rg stand-in: honours -e PATTERN, --fixed-strings and the path after --; ignores the rest.
fixed=""; pattern=""; path="."
while [ $# -gt 0 ]; do
  case "$1" in
    -e) pattern="$2"; shift 2 ;;
    --fixed-strings) fixed="-F"; shift ;;
    --glob|--max-columns) shift 2 ;;
    --) path="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "$*" > /dev/null
grep -rnH $fixed --exclude-dir=node_modules --exclude-dir=.hidden --exclude-dir=build --exclude=*.log --exclude=*.bin -e "$pattern" "$path"
`,
    );
    chmodSync(fake, 0o755);
    const h = harness({ defaultRepoPath: fixture(), ripgrep: fake });
    expect(h.mgr.searchBackend).toBe(fake);
    const port = await h.mgr.acquire("w1", "shared_ro");
    const r = await port.exec("read", { op: "search", pattern: "TODO: remove" });
    expect(r.output).toBe("src/deep/util.ts:1:// TODO: remove\n");
    expect((await port.exec("read", { op: "search", pattern: "zzz-none" })).output).toBe("No matches.\n");
  });
});
