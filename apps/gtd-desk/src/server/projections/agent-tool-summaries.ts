import type { ToolStepDTO } from "../../shared/api";

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
export const oneLine = (text: string, max: number) => clip(text.replace(/\s+/g, " ").trim(), max);
export function callBrief(input: unknown): string {
  if (input === null || typeof input !== "object") return typeof input === "string" ? oneLine(input, 300) : "";
  const o = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "file_path", "path", "filePath", "notebook_path", "pattern", "query", "url", "title", "to", "artifactId", "cellId", "name"]) {
    const val = o[k];
    if (typeof val === "string" && val) return oneLine(val, 300);
    if (Array.isArray(val) && val.every((x) => typeof x === "string") && val.length) return oneLine(val.join(" "), 300);
  }
  if (Array.isArray(o["changes"])) return oneLine(changedPaths(o).join(", "), 300);
  if (typeof o["input"] === "string") return oneLine(o["input"], 300);
  const json = JSON.stringify(o);
  return json === "{}" ? "" : oneLine(json, 200);
}

function changedPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  if (Array.isArray(o["changes"])) {
    return (o["changes"] as unknown[]).flatMap((c) => (c && typeof c === "object" && typeof (c as Record<string, unknown>)["path"] === "string" ? [(c as Record<string, string>)["path"]!] : []));
  }
  if (o["changes"] && typeof o["changes"] === "object") return Object.keys(o["changes"] as object);
  for (const k of ["file_path", "path", "filePath", "notebook_path", "target_file", "TargetFile"]) if (typeof o[k] === "string" && o[k]) return [o[k] as string];
  return [];
}

/** MCP-qualified names ("mcp__ng__save_artifact", "ng.save_artifact") reduced to the tool's own name. */
export const baseName = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "").replace(/^[\w-]+\./, "");

const READ = /^(read|read_file|view|view_file|grep|glob|ls|list_dir|list_files|find_files|grep_search|file_search|codebase_search|search_files|notebookread)$/i;
const EDIT = /^(edit|write|multiedit|notebookedit|apply_patch|write_file|edit_file|create_file|str_replace_editor|replace_file_content|write_to_file|file_change)$/i;
const RUN = /^(bash|shell|command|exec_command|local_shell|run_command|run_terminal_command|command_execution|job_start)$/i;
const WEB = /^(websearch|web_search|webfetch|web_fetch|read_url_content|search_web)$/i;
const KERNEL_TOOL_ZH: Readonly<Record<string, string>> = {
  save_artifact: "保存报告",
  patch_artifact: "修订报告",
  read_artifact: "读取报告",
  set_state: "更新记录",
  read_state: "查看记录",
  report_to_parent: "汇报进展",
  send_message: "发消息",
  request_approval: "提交确认卡",
  inspect_cell: "查看分身记录",
  spawn_cell: "派出分身",
  dispatch: "派出分身",
  update_cell: "调整分身",
  control_cell: "调度分身",
  close_cell: "结束分身",
  wait: "进入等待",
  save_note: "更新笔记",
  read_resource: "读取完整输出",
  search_history: "翻查历史",
  set_reminder: "设提醒",
  cancel_scheduled: "取消提醒",
  track_action: "记录行动",
  complete_self: "收尾",
  pause_self: "暂停自己",
  handback: "交回总助理",
  job_observe: "查看后台命令",
  job_input: "向后台命令输入",
  job_cancel: "停止后台命令",
};

function relPath(path: string, cwd: string | null): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

/** "执行了 6 步操作：读取 3 个文件 · 修改 src/retry.ts · 运行 pnpm test（通过）" */
export function toolSummary(steps: readonly ToolStepDTO[], inputs: ReadonlyMap<number, unknown>, cwd: string | null): string {
  const parts = new Map<string, { kind: "read" | "edit" | "run" | "web" | "other"; label: string; items: string[]; runs: Array<{ cmd: string; ok: boolean | null }>; n: number }>();
  for (const s of steps) {
    const base = baseName(s.name);
    const kind = READ.test(base) ? "read" : EDIT.test(base) ? "edit" : RUN.test(base) ? "run" : WEB.test(base) ? "web" : "other";
    const key = kind === "other" ? (KERNEL_TOOL_ZH[base] ?? base) : kind;
    let p = parts.get(key);
    if (!p) parts.set(key, (p = { kind, label: key, items: [], runs: [], n: 0 }));
    p.n++;
    if (kind === "read" && s.brief && !p.items.includes(s.brief)) p.items.push(s.brief);
    if (kind === "edit") for (const path of changedPaths(inputs.get(s.seq)).map((x) => relPath(x, cwd))) if (!p.items.includes(path)) p.items.push(path);
    if (kind === "run") p.runs.push({ cmd: oneLine((s.brief || s.name).split("\n")[0]!, 60), ok: s.ok });
  }
  const text = [...parts.values()].map((p) => {
    switch (p.kind) {
      case "read":
        return p.items.length === 1 ? `读取 ${relPath(p.items[0]!, cwd)}` : `读取 ${p.items.length || p.n} 个文件`;
      case "edit":
        return p.items.length === 0 ? `修改 ${p.n} 处文件` : p.items.length <= 2 ? `修改 ${p.items.join("、")}` : `修改 ${p.items.slice(0, 2).join("、")} 等 ${p.items.length} 个文件`;
      case "run": {
        const shown = p.runs.slice(-2).map((r) => `运行 ${r.cmd}（${r.ok === null ? "进行中" : r.ok ? "通过" : "失败"}）`);
        return p.runs.length > 2 ? `${shown.join(" · ")} 等 ${p.runs.length} 条命令` : shown.join(" · ");
      }
      case "web":
        return `查资料 ${p.n} 次`;
      default:
        return p.n > 1 ? `${p.label} ×${p.n}` : p.label;
    }
  });
  return `执行了 ${steps.length} 步操作：${text.join(" · ")}`;
}
