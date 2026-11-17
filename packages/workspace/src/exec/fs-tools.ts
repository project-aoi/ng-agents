import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NgError, type ExecResult } from "@ng/protocol";
import { resolveWorkspacePath, type PathPolicy } from "./paths";

const BINARY_SNIFF_BYTES = 8192;
const MAX_READ_FILE_BYTES = 32 * 1024 * 1024;

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function sniffFile(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function statOrNotFound(abs: string, input: string) {
  try {
    return statSync(abs);
  } catch {
    throw new NgError("not_found", `no such file or directory: ${input}`);
  }
}

export function readFileTool(
  policy: PathPolicy,
  args: { path: string; offset?: number | undefined; limit?: number | undefined },
  limits: { readMaxLines: number; readMaxChars: number },
): ExecResult {
  const { abs, rel } = resolveWorkspacePath(policy, args.path);
  const st = statOrNotFound(abs, args.path);
  if (st.isDirectory()) throw new NgError("invalid_argument", `${rel} is a directory (use op "list_dir")`);
  if (looksBinary(sniffFile(abs))) return { output: `[binary file ${rel}, ${st.size} bytes]` };
  if (st.size > MAX_READ_FILE_BYTES) {
    throw new NgError("invalid_argument", `${rel} is ${st.size} bytes; too large to read whole — use search, or bash (head/sed/grep) on it`);
  }

  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const offset = args.offset ?? 0;
  const limit = args.limit ?? limits.readMaxLines;
  if (offset >= total && total > 0) {
    return { output: `[${rel} has ${total} lines; offset ${offset} is past the end]` };
  }
  let out = "";
  let shown = 0;
  let truncated = false;
  for (let i = offset; i < Math.min(total, offset + limit); i++) {
    const line = lines[i]!;
    if (out.length + line.length + 1 > limits.readMaxChars) {
      truncated = true;
      break;
    }
    out += line + "\n";
    shown++;
  }
  const end = offset + shown;
  if (end < total) {
    truncated = true;
    out += `[... showing lines ${offset + 1}-${end} of ${total}; read again with offset ${end} for more]\n`;
  }
  return truncated ? { output: out, truncated } : { output: out };
}

const NO_DESCEND = new Set(["node_modules"]);

export function listDirTool(policy: PathPolicy, args: { path?: string | undefined; depth?: number | undefined }, limits: { listMaxEntries: number }): ExecResult {
  const { abs, rel } = resolveWorkspacePath(policy, args.path ?? ".");
  const st = statOrNotFound(abs, args.path ?? ".");
  if (!st.isDirectory()) throw new NgError("invalid_argument", `${rel} is not a directory`);
  const depth = args.depth ?? 1;
  const out: string[] = [];
  let truncated = false;

  const walk = (dir: string, prefix: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name === ".git") continue;
      if (out.length >= limits.listMaxEntries) {
        truncated = true;
        return;
      }
      const name = prefix + e.name;
      if (e.isSymbolicLink()) out.push(`${name}@`);
      else if (e.isDirectory()) {
        out.push(`${name}/`);
        if (level < depth && !NO_DESCEND.has(e.name)) walk(join(dir, e.name), `${name}/`, level + 1);
      } else out.push(name);
    }
  };
  walk(abs, "", 1);
  let output = out.length ? out.join("\n") + "\n" : "[empty directory]\n";
  if (truncated) output += `[... truncated at ${limits.listMaxEntries} entries]\n`;
  return truncated ? { output, truncated } : { output };
}

export function writeTool(policy: PathPolicy, args: { path: string; content: string }): ExecResult {
  const { abs, rel } = resolveWorkspacePath(policy, args.path);
  try {
    if (lstatSync(abs).isDirectory()) throw new NgError("invalid_argument", `${rel} is a directory`);
  } catch (e) {
    if (e instanceof NgError) throw e;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, args.content, "utf8");
  return { output: `Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${rel}` };
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

export function editTool(policy: PathPolicy, args: { path: string; oldText: string; newText: string; replaceAll?: boolean | undefined }): ExecResult {
  const { abs, rel } = resolveWorkspacePath(policy, args.path);
  const st = statOrNotFound(abs, args.path);
  if (st.isDirectory()) throw new NgError("invalid_argument", `${rel} is a directory`);
  const text = readFileSync(abs, "utf8");
  const n = countOccurrences(text, args.oldText);
  if (n === 0) throw new NgError("invalid_argument", `oldText was not found in ${rel}; read the file and copy the exact text`);
  if (n > 1 && !args.replaceAll) {
    throw new NgError("invalid_argument", `oldText occurs ${n} times in ${rel}; include more surrounding context to make it unique, or set replaceAll`);
  }
  const next = args.replaceAll ? text.split(args.oldText).join(args.newText) : text.replace(args.oldText, () => args.newText);
  writeFileSync(abs, next, "utf8");
  return { output: `Edited ${rel}: replaced ${args.replaceAll ? n : 1} occurrence${(args.replaceAll ? n : 1) === 1 ? "" : "s"}` };
}
