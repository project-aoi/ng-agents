import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where a checkout stands, in one clause for a person; null when the directory is no git work tree (or git did not answer). */
export async function workTreeText(dir: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", dir, "status", "--porcelain=v2", "--branch"], { encoding: "utf8", timeout: 3_000 });
    const lines = stdout.split("\n").filter(Boolean);
    const head = lines.find((l) => l.startsWith("# branch.head "))?.slice("# branch.head ".length).trim() ?? "";
    const where = head && head !== "(detached)" ? `停在分支 ${head}` : "没有检出任何分支（游离 HEAD）";
    const dirty = lines.filter((l) => !l.startsWith("#")).length;
    return `${dir} 现在${where}，${dirty > 0 ? `有 ${dirty} 处未提交的改动` : "没有未提交的改动"}`;
  } catch {
    return null;
  }
}
